<?php
/**
 * Plugin Name: CEIA Asaas Webhook Relay
 * Description: Recebe webhooks do Asaas e os disponibiliza para os nós CEIA_OS via polling.
 * Version:     1.0.0
 *
 * INSTALAÇÃO:
 *   1. Copie este arquivo para wp-content/plugins/ceia-asaas-webhook/ceia-asaas-webhook.php
 *   2. Ative o plugin no painel WordPress (Plugins → Ativar)
 *   3. O plugin cria as tabelas automaticamente na ativação
 *
 * ENDPOINTS REGISTRADOS:
 *   POST /wp-json/ceia/v1/asaas/register-node   — nó registra webhook_secret (requer X-Ceia-Node-Token)
 *   POST /wp-json/ceia/v1/asaas/webhook          — Asaas posta eventos (público, valida asaas-access-token)
 *   GET  /wp-json/ceia/v1/asaas/events           — nó busca eventos pendentes (requer X-Ceia-Node-Token)
 *   POST /wp-json/ceia/v1/asaas/events/ack       — nó confirma eventos processados (requer X-Ceia-Node-Token)
 *
 * TABELAS:
 *   ceia_asaas_nodes  — mapeia node_token → webhook_secret
 *   ceia_asaas_events — fila de eventos para consumo idempotente
 */

if ( ! defined( 'ABSPATH' ) ) exit;

// ── Ativação: criação das tabelas ─────────────────────────────────────────────

register_activation_hook( __FILE__, 'ceia_asaas_install' );

function ceia_asaas_install() {
    global $wpdb;
    $charset = $wpdb->get_charset_collate();

    $sql_nodes = "CREATE TABLE IF NOT EXISTS {$wpdb->prefix}ceia_asaas_nodes (
        id             INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        node_token     VARCHAR(128) NOT NULL UNIQUE,
        webhook_secret VARCHAR(128) NOT NULL,
        updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) $charset;";

    $sql_events = "CREATE TABLE IF NOT EXISTS {$wpdb->prefix}ceia_asaas_events (
        id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        event_id     VARCHAR(64)  NOT NULL UNIQUE,
        node_token   VARCHAR(128) NOT NULL,
        event_type   VARCHAR(64)  NOT NULL,
        payment_id   VARCHAR(64)  DEFAULT NULL,
        payment_link VARCHAR(64)  DEFAULT NULL,
        status       VARCHAR(32)  DEFAULT NULL,
        raw          LONGTEXT     NOT NULL,
        consumed     TINYINT(1)   NOT NULL DEFAULT 0,
        created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) $charset;";

    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    dbDelta( $sql_nodes );
    dbDelta( $sql_events );
}

// ── Registro das rotas ────────────────────────────────────────────────────────

add_action( 'rest_api_init', 'ceia_asaas_register_routes' );

function ceia_asaas_register_routes() {
    register_rest_route( 'ceia/v1', '/asaas/register-node', [
        'methods'             => 'POST',
        'callback'            => 'ceia_asaas_register_node',
        'permission_callback' => '__return_true', // validação manual por token
    ] );

    register_rest_route( 'ceia/v1', '/asaas/webhook', [
        'methods'             => 'POST',
        'callback'            => 'ceia_asaas_receive_webhook',
        'permission_callback' => '__return_true', // público — Asaas posta aqui
    ] );

    register_rest_route( 'ceia/v1', '/asaas/events', [
        'methods'             => 'GET',
        'callback'            => 'ceia_asaas_get_events',
        'permission_callback' => '__return_true', // validação manual por token
    ] );

    register_rest_route( 'ceia/v1', '/asaas/events/ack', [
        'methods'             => 'POST',
        'callback'            => 'ceia_asaas_ack_events',
        'permission_callback' => '__return_true', // validação manual por token
    ] );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Valida X-Ceia-Node-Token e retorna o node_token string ou WP_Error.
 */
function ceia_asaas_get_node_token( WP_REST_Request $request ) {
    $token = $request->get_header( 'X-Ceia-Node-Token' );
    if ( empty( $token ) ) {
        return new WP_Error( 'unauthorized', 'X-Ceia-Node-Token ausente', [ 'status' => 401 ] );
    }
    return sanitize_text_field( $token );
}

function ceia_asaas_json( $data, $status = 200 ) {
    return new WP_REST_Response( $data, $status );
}

// ── POST /asaas/register-node ─────────────────────────────────────────────────

function ceia_asaas_register_node( WP_REST_Request $request ) {
    global $wpdb;

    $token = ceia_asaas_get_node_token( $request );
    if ( is_wp_error( $token ) ) return $token;

    $body   = $request->get_json_params();
    $secret = isset( $body['webhook_secret'] ) ? sanitize_text_field( $body['webhook_secret'] ) : '';

    if ( empty( $secret ) ) {
        return ceia_asaas_json( [ 'ok' => false, 'error' => 'webhook_secret obrigatório' ], 400 );
    }

    $table = $wpdb->prefix . 'ceia_asaas_nodes';
    $wpdb->query(
        $wpdb->prepare(
            "INSERT INTO `$table` (node_token, webhook_secret) VALUES (%s, %s)
             ON DUPLICATE KEY UPDATE webhook_secret = VALUES(webhook_secret), updated_at = NOW()",
            $token,
            $secret
        )
    );

    return ceia_asaas_json( [ 'ok' => true ] );
}

// ── POST /asaas/webhook ───────────────────────────────────────────────────────

function ceia_asaas_receive_webhook( WP_REST_Request $request ) {
    global $wpdb;

    // Parâmetro ?node= identifica o nó de destino
    $node_token = sanitize_text_field( $request->get_param( 'node' ) );

    // Corpo bruto do Asaas
    $raw  = $request->get_body();
    $body = $request->get_json_params();

    if ( empty( $body ) ) {
        // Sempre responde 200 para não interromper a fila do Asaas
        return ceia_asaas_json( [ 'ok' => false, 'error' => 'body inválido' ] );
    }

    // Valida asaas-access-token (authToken configurado no webhook)
    if ( ! empty( $node_token ) ) {
        $nodes_table = $wpdb->prefix . 'ceia_asaas_nodes';
        $row = $wpdb->get_row(
            $wpdb->prepare( "SELECT webhook_secret FROM `$nodes_table` WHERE node_token = %s LIMIT 1", $node_token ),
            ARRAY_A
        );
        if ( $row ) {
            $expected_secret = $row['webhook_secret'];
            $received_token  = $request->get_header( 'asaas-access-token' );
            if ( $received_token !== $expected_secret ) {
                // Log mas responde 200 mesmo assim (não queremos que Asaas pare de tentar)
                error_log( "[CEIA-ASAAS] token inválido para nó $node_token" );
                return ceia_asaas_json( [ 'ok' => true ] );
            }
        }
    }

    // Extrai campos do evento Asaas
    $event_id    = isset( $body['id'] )              ? sanitize_text_field( $body['id'] )              : '';
    $event_type  = isset( $body['event'] )           ? sanitize_text_field( $body['event'] )           : '';
    $payment     = isset( $body['payment'] )         ? $body['payment']                                : [];
    $payment_id  = isset( $payment['id'] )           ? sanitize_text_field( $payment['id'] )           : null;
    $pay_link    = isset( $payment['paymentLink'] )  ? sanitize_text_field( $payment['paymentLink'] )  : null;
    $pay_status  = isset( $payment['status'] )       ? sanitize_text_field( $payment['status'] )       : null;

    if ( empty( $event_id ) || empty( $event_type ) ) {
        return ceia_asaas_json( [ 'ok' => true ] ); // evento malformado — ignora silencioso
    }

    $events_table = $wpdb->prefix . 'ceia_asaas_events';

    // Dedup por event_id — INSERT IGNORE evita duplicatas
    $wpdb->query(
        $wpdb->prepare(
            "INSERT IGNORE INTO `$events_table`
                (event_id, node_token, event_type, payment_id, payment_link, status, raw)
             VALUES (%s, %s, %s, %s, %s, %s, %s)",
            $event_id,
            $node_token ?: '',
            $event_type,
            $payment_id,
            $pay_link,
            $pay_status,
            $raw
        )
    );

    return ceia_asaas_json( [ 'ok' => true ] );
}

// ── GET /asaas/events ─────────────────────────────────────────────────────────

function ceia_asaas_get_events( WP_REST_Request $request ) {
    global $wpdb;

    $token = ceia_asaas_get_node_token( $request );
    if ( is_wp_error( $token ) ) return $token;

    $events_table = $wpdb->prefix . 'ceia_asaas_events';

    $rows = $wpdb->get_results(
        $wpdb->prepare(
            "SELECT event_id, event_type, payment_id, payment_link, status
             FROM `$events_table`
             WHERE node_token = %s AND consumed = 0
             ORDER BY id ASC
             LIMIT 100",
            $token
        ),
        ARRAY_A
    );

    return ceia_asaas_json( [ 'ok' => true, 'events' => $rows ?: [] ] );
}

// ── POST /asaas/events/ack ────────────────────────────────────────────────────

function ceia_asaas_ack_events( WP_REST_Request $request ) {
    global $wpdb;

    $token = ceia_asaas_get_node_token( $request );
    if ( is_wp_error( $token ) ) return $token;

    $body      = $request->get_json_params();
    $event_ids = isset( $body['event_ids'] ) && is_array( $body['event_ids'] )
        ? array_map( 'sanitize_text_field', $body['event_ids'] )
        : [];

    if ( empty( $event_ids ) ) {
        return ceia_asaas_json( [ 'ok' => false, 'error' => 'event_ids obrigatório' ], 400 );
    }

    $events_table = $wpdb->prefix . 'ceia_asaas_events';
    $placeholders = implode( ', ', array_fill( 0, count( $event_ids ), '%s' ) );

    $wpdb->query(
        $wpdb->prepare(
            "UPDATE `$events_table`
             SET consumed = 1
             WHERE node_token = %s AND event_id IN ($placeholders)",
            array_merge( [ $token ], $event_ids )
        )
    );

    return ceia_asaas_json( [ 'ok' => true, 'acked' => count( $event_ids ) ] );
}
