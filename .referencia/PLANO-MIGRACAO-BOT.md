# Plano de Migração — Bot Telegram para CEIA_OS

**Data:** 2026-05-20  
**Decisão arquitetural:** CEIA_OS mantém schema relacional como fonte da verdade. O bot será reescrito em JavaScript (Node.js + Telegraf) para usar diretamente o `db.js` do CEIA_OS. O Frota CEIA (`Downloads/frota.ceia/`) será descontinuado.

---

## PASSO 1 — O que o bot faz com dados

### 1.1 Registro de motoboy (fluxo `/start` + entrevista)

| Evento | Função chamada | O que grava |
|---|---|---|
| `/start` com token válido | `validarEUsarToken(token)` | Marca `tokens_cadastro.usado = 1` |
| `/start` sem token válido | — | Bloqueia. Não grava nada. |
| `/start` com `nuvem_<pacoteId>` | `upsertFleet({...vinculo:'Nuvem', status:'CADASTRANDO'})` | Cria ou atualiza row em `motoboys` por `telegram_id` |
| Cada resposta da entrevista (nome, whatsapp, vinculo, pix, veiculo) | `upsertFleet({telegram_id, campo, status:'CADASTRANDO'})` | Atualiza progressivamente a row |
| Final da entrevista (VEICULO) | `upsertFleet({...status:'CADASTRANDO'})` | Grava todos os campos; se Freelancer, dispara POST externo para `frota.ceia.ia.br` |

**Campos gravados no `motoboys`:** `telegram_id`, `nome`, `cpf` (na verdade é o whatsapp), `vinculo` (Fixo/Freelancer/Nuvem), `pix`, `veiculo`, `status` (CADASTRANDO/ONLINE/OFFLINE/EM_ENTREGA), `lat`, `lng`, `ultima_atualizacao`, `pagamento_pendente`, `pendente_desde`, `no_nome`, `no_url`.

### 1.2 GPS e ponto de expediente

| Evento | Função | O que grava |
|---|---|---|
| Localização em tempo real recebida | `upsertFleet({telegram_id, latitude, longitude, status:'ONLINE'})` | Atualiza `lat`, `lng`, `ultima_atualizacao`, `status` |
| Edição de localização (live update) | `upsertFleet({telegram_id, latitude, longitude, status:'ONLINE'})` | Idem |
| `/offline` | `upsertFleet({telegram_id, status:'OFFLINE'})` | Muda status |
| Cron de inatividade | `limparRadarInativo()` | `UPDATE motoboys SET status='OFFLINE' WHERE ultima_atualizacao < now - 5min` |

### 1.3 Aceite/recusa de rota

| Evento | Funções | O que grava |
|---|---|---|
| Botão `aceitar_<pacoteId>` | `getPacotes()`, `getPedidos()`, `savePacote(pacote)`, `atualizarCamposMotoboy(tid, {status:'EM_ENTREGA'})` | Atualiza JSON blob do pacote (`motoboy`, `status:'EM_ROTA'`, `pedidos_snapshot`); atualiza `motoboys.status` |
| Botão `recusar_<pacoteId>` | `getPacotes()`, `savePacote(pacote)` | Atualiza JSON blob do pacote (`motoboy:null`, `status:'AGUARDANDO'`) |

### 1.4 Baixa por código 4 dígitos

Função: `processarBaixaPeloTelegram(telegram_id, codigo)`

1. `getRotasAtivas()` → carrega todos pacotes EM_ROTA/PENDENTE_ACEITE + pedidos por JSON blob
2. Encontra rota onde `pacote.motoboy.telegram_id === telegram_id` e `pedido.codigo_entrega === codigo`
3. `registrarEntrega(telegram_id, pedido.taxa)` → INSERT em `entregas`
4. Remove `pedido.id` de `pacote.pedidosIds`; se pacote vazio → `deletePacote`; senão → `savePacote`
5. `deletePedido(pedido.id)` → DELETE de `pedidos`
6. Emite SSE `BAIXA_PEDIDO`

**Dependência crítica:** `pedido.codigo_entrega` e `pedido.taxa` são campos dentro do JSON blob do pedido.

### 1.5 Confirmação de pagamento

| Evento | Funções | O que grava |
|---|---|---|
| Botão `confirmar_pgto_<motoboyTid>` | `getMotoboyByTelegramId`, `deletarMotoboy` (se Nuvem) ou `atualizarCamposMotoboy(tid, {pagamento_pendente:0, pendente_desde:null, status:'ONLINE'})` | Remove motoboy Nuvem; ou limpa flags de pendência |
| Botão `pgto_pendente_<motoboyTid>` | `atualizarCamposMotoboy(tid, {pagamento_pendente:1, pendente_desde:now, status:'OFFLINE'})` | Marca pendência |

### 1.6 Extrato financeiro

- `getExtratoFinanceiro(telegram_id)` → `SELECT * FROM entregas WHERE telegram_id = ? AND status = 'PENDENTE'`
- `zerarAcertoFinanceiro(telegram_id)` → `UPDATE entregas SET status = 'PAGO' WHERE telegram_id = ? AND status = 'PENDENTE'`
- `inserirHistoricoMotoboy(telegram_id, tipo, valor, descricao)` → INSERT em `historico_motoboys`

### 1.7 Falar com cliente (relay WhatsApp via Telegram)

- `getRotasMotoboy(telegram_id)` → pedidos ativos do motoboy via JSON blobs
- Usa `pedido.telefone || pedido.telefoneCliente || pedido.whatsapp || pedido.telefone_cliente` — campo inconsistente nos blobs
- `enviarMensagemWhatsApp(numero, texto)` — função externa, não banco

### 1.8 Desvinculação

- `/sair` ou `/desvincular`: `deletarMotoboy(telegram_id)` → DELETE em `motoboys` + `entregas`

---

## PASSO 2 — Schema atual do CEIA_OS (`ceia.db`)

### Tabelas relevantes para a migração

#### `motoboys` (pós-Fase 9)
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
nome TEXT NOT NULL
telefone TEXT
status TEXT DEFAULT 'ativo'           -- administrativo: ativo/inativo
criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
-- Fase 9 additions (ALTER TABLE):
telegram_id TEXT                       -- SEM UNIQUE INDEX ainda
whatsapp TEXT
cpf TEXT
vinculo TEXT DEFAULT 'Fixo'           -- Fixo / Freelancer / Nuvem
veiculo TEXT DEFAULT 'Moto'
pix TEXT
operacional_status TEXT DEFAULT 'OFFLINE'  -- ONLINE / EM_ROTA / OFFLINE
pagamento_pendente INTEGER DEFAULT 0
saldo_acerto REAL DEFAULT 0           -- substitui tabela entregas (simplificado)
no_nome TEXT
lat REAL
lng REAL
ultima_atualizacao DATETIME
```

#### `pedidos`
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
codigo TEXT UNIQUE NOT NULL            -- código humanamente legível (ex: PED-0001)
cliente_nome TEXT
cliente_whatsapp TEXT
endereco TEXT
bairro TEXT
complemento TEXT
itens TEXT                             -- JSON string dos itens
subtotal REAL DEFAULT 0
taxa_entrega REAL DEFAULT 0
total REAL DEFAULT 0
forma_pagamento TEXT
origem TEXT DEFAULT 'manual'
status TEXT DEFAULT 'preparacao'       -- preparacao / aguardando_coleta / em_rota / entregue / cancelado
asaas_payment_id TEXT
pacote_id INTEGER                      -- FK para pacotes.id
motoboy_id INTEGER                     -- FK para motoboys.id
criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
finalizado_em DATETIME
lat REAL
lng REAL
```

**Ausente no CEIA_OS:** `codigo_entrega` (código 4 dígitos para baixa pelo bot) — **BLOQUEANTE para integração de baixa**.

#### `pacotes`
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
status TEXT DEFAULT 'montando'         -- montando / aguardando_coleta / em_rota / finalizado
motoboy_id INTEGER                     -- FK para motoboys.id
criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
despachado_em DATETIME
coletado_em DATETIME
finalizado_em DATETIME
```

**Relação com pedidos:** `pedidos.pacote_id` aponta para `pacotes.id`. Para saber os pedidos de um pacote: `SELECT * FROM pedidos WHERE pacote_id = ?`.

#### `config`
```sql
key TEXT PRIMARY KEY
value TEXT
```

Usada para armazenar configurações globais (telegram_bot_token, google_maps_key, etc.).

**Ausente no CEIA_OS:** `tokens_cadastro` — **BLOQUEANTE para fluxo de convite QR**.

#### `estornos`
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
pedido_id INTEGER NOT NULL (FK pedidos.id)
valor REAL NOT NULL
motivo TEXT
asaas_refund_id TEXT
status TEXT DEFAULT 'pendente'
criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
```

---

## PASSO 3 — Tabela de tradução

| Frota CEIA | CEIA_OS equivalente | Diferença / Gap |
|---|---|---|
| `upsertFleet({telegram_id, ...})` | `saveMotoboy(dados)` com allowlist | **Chave:** CEIA_OS usa `id` INTEGER; bot usa `telegram_id` TEXT. Precisa de UNIQUE INDEX e upsert por `telegram_id`. |
| `getMotoboyByTelegramId(tid)` | Sem equivalente | Adicionar: `SELECT * FROM motoboys WHERE telegram_id = ?` |
| `atualizarCamposMotoboy(tid, campos)` | `saveMotoboy({id, ...campos})` | CEIA_OS atualiza por `id`, não por `telegram_id`. Precisa lookup ou nova função. |
| `deletarMotoboy(tid)` | `DELETE FROM motoboys WHERE id = ?` | Mesma lógica, chave diferente. |
| `validarEUsarToken(token)` | Sem equivalente | `tokens_cadastro` não existe no CEIA_OS. |
| `gerarTokenCadastro()` | `gerarTokenConvite()` (gerado na Fase 9) | Fase 9 usa tabela `config`. Substituir por tabela dedicada `tokens_cadastro`. |
| `registrarEntrega(tid, valor, taxa)` | Sem equivalente direto | CEIA_OS usa `saldo_acerto REAL` no motoboy (agregado). Frota CEIA tem `entregas` com linha por entrega. **Decisão necessária:** manter agregado ou criar tabela `entregas`. |
| `getExtratoFinanceiro(tid)` | `getExtratoMotoboy(id)` via JOIN pedidos/pacotes | CEIA_OS busca pelo financeiro derivado dos pedidos. Frota CEIA tem registros independentes em `entregas`. |
| `zerarAcertoFinanceiro(tid)` | `zerarAcertoMotoboy(id)` | CEIA_OS atualiza coluna `saldo_acerto`. Frota CEIA marca linhas em `entregas` como PAGO. |
| `inserirHistoricoMotoboy(tid, tipo, valor, desc)` | Sem equivalente | `historico_motoboys` não existe no CEIA_OS. |
| `getHistoricoMotoboy(tid)` | `getHistoricoMotoboy(id)` (Fase 9) | Fase 9 usa JOIN pedidos/pacotes, não tabela dedicada. |
| `getPacotes()` / `savePacote(blob)` | `SELECT * FROM pacotes` + UPDATE colunas | **Conflito fundamental:** bot usa JSON blob; CEIA_OS usa colunas relacionais. Bot não pode chamar `savePacote` diretamente. |
| `getPedidos()` / `savePedido(blob)` | `SELECT * FROM pedidos` + UPDATE colunas | Idem. Bot lê `pedido.codigo_entrega` do blob — não existe como coluna no CEIA_OS. |
| `deletePedido(id)` / `deletePacote(id)` | `DELETE FROM pedidos/pacotes WHERE id = ?` | IDs são TEXT no Frota (UUID) vs INTEGER no CEIA_OS. |
| `processarBaixaPeloTelegram(tid, cod)` | Sem equivalente | Depende de `pedido.codigo_entrega` + `pedido.taxa` — campos ausentes no schema relacional. |
| `getRotasMotoboy(tid)` | Sem equivalente (derivado de pacotes + pedidos) | No CEIA_OS: `SELECT p.* FROM pedidos p JOIN pacotes pk ON pk.id = p.pacote_id WHERE pk.motoboy_id = (SELECT id FROM motoboys WHERE telegram_id = ?) AND p.status = 'em_rota'` |
| `limparRadarInativo()` | Sem equivalente | `UPDATE motoboys SET operacional_status = 'OFFLINE' WHERE ultima_atualizacao < datetime('now', '-5 minutes')` — simples de adicionar. |
| `repassarConviteNuvem(tid, dados)` | Sem equivalente | Função de saída (Telegram API), não banco. Só precisa do `telegram_id` do motoboy Freelancer. |

---

## PASSO 4 — Mudanças de schema necessárias

### 4.1 CRÍTICO — Bloqueiam funcionalidades do bot

#### A. `UNIQUE INDEX` em `motoboys.telegram_id`
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_motoboys_telegram_id ON motoboys(telegram_id);
```
Necessário para que o bot possa fazer upsert seguro por `telegram_id`.

#### B. Nova coluna `pedidos.codigo_entrega`
```sql
ALTER TABLE pedidos ADD COLUMN codigo_entrega TEXT;
```
Código de 4 dígitos gerado no momento do despacho, informado ao cliente via WhatsApp, confirmado pelo motoboy no Telegram. **Sem este campo, a baixa de entrega pelo bot não funciona.**

#### C. Nova tabela `tokens_cadastro`
```sql
CREATE TABLE IF NOT EXISTS tokens_cadastro (
  token TEXT PRIMARY KEY,
  usado INTEGER DEFAULT 0,
  criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
Substitui o armazenamento atual em `config`. Permite múltiplos tokens ativos, rastreabilidade de uso.

### 4.2 IMPORTANTE — Melhoram confiabilidade mas têm workaround

#### D. Nova tabela `entregas` (alternativa a `saldo_acerto` agregado)
```sql
CREATE TABLE IF NOT EXISTS entregas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  motoboy_id INTEGER NOT NULL,           -- FK motoboys.id (não telegram_id)
  pedido_id INTEGER,                     -- FK pedidos.id (rastreabilidade)
  valor_entrega REAL,
  taxa_deslocamento REAL DEFAULT 0,
  status TEXT DEFAULT 'PENDENTE',        -- PENDENTE / PAGO
  data DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (motoboy_id) REFERENCES motoboys(id),
  FOREIGN KEY (pedido_id) REFERENCES pedidos(id)
);
```
**Alternativa sem essa tabela:** manter `saldo_acerto REAL` como acumulador no motoboy. Perde histórico granular de entregas.

#### E. Nova tabela `historico_motoboys`
```sql
CREATE TABLE IF NOT EXISTS historico_motoboys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  motoboy_id INTEGER NOT NULL,           -- FK motoboys.id
  tipo TEXT,                             -- ENTREGA / ACERTO / PENALIDADE / etc.
  valor REAL,
  descricao TEXT,
  data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (motoboy_id) REFERENCES motoboys(id)
);
```
**Alternativa sem essa tabela:** a Fase 9 do `getHistoricoMotoboy` já faz JOIN em pedidos/pacotes para montar histórico. Funcional, mas menos flexível.

#### F. Coluna `pendente_desde` em `motoboys`
```sql
ALTER TABLE motoboys ADD COLUMN pendente_desde DATETIME;
```
Para controlar limpeza automática de motoboys Nuvem com pagamento pendente há mais de 30 dias.

### 4.3 COSMÉTICO — Renomear para consistência com o bot

O bot usa `status` como estado operacional (ONLINE/OFFLINE/EM_ENTREGA). O CEIA_OS dividiu em:
- `status` = administrativo (ativo/inativo)
- `operacional_status` = operacional (ONLINE/OFFLINE/EM_ROTA)

O bot precisará mapear: ao gravar `status:'ONLINE'` → gravar em `operacional_status`; ao gravar `status:'ativo'` → gravar em `status`.

---

## PASSO 5 — Ordem de implementação

### Fase Bot-1: Schema (sem quebrar nada)
1. `CREATE UNIQUE INDEX idx_motoboys_telegram_id` — seguro, falha silenciosa se já existir
2. `ALTER TABLE pedidos ADD COLUMN codigo_entrega TEXT` — não-nulo opcional, retrocompatível
3. `ALTER TABLE motoboys ADD COLUMN pendente_desde DATETIME` — retrocompatível
4. `CREATE TABLE IF NOT EXISTS tokens_cadastro` — nova tabela, não impacta nada
5. `CREATE TABLE IF NOT EXISTS entregas` — nova tabela, não impacta nada (opcional se usar `saldo_acerto`)
6. Migrar `gerarTokenConvite()` do `db.js` para usar `tokens_cadastro` em vez de `config`

### Fase Bot-2: Novas funções no `db.js`
1. `getMotobyByTelegramId(telegram_id)` — SELECT simples
2. `upsertMotoboByTelegramId(dados)` — upsert por `telegram_id`, mapeando `status` → `operacional_status`
3. `atualizarCamposMotoboByTelegramId(telegram_id, campos)` — UPDATE por `telegram_id`
4. `deletarMotoboByTelegramId(telegram_id)` — DELETE + entregas relacionadas
5. `validarEUsarToken(token)` — SELECT + UPDATE em `tokens_cadastro`
6. `getRotasMotoboByTelegramId(telegram_id)` — JOIN pedidos/pacotes/motoboys
7. `processarBaixaRelacional(telegram_id, codigo_entrega)` — substitui `processarBaixaPeloTelegram`; usa `pedidos.codigo_entrega` + UPDATE status, não DELETE
8. `registrarEntregaRelacional(motoboy_id, pedido_id, valor, taxa)` — INSERT em `entregas` ou UPDATE `saldo_acerto`
9. `gerarCodigoEntrega()` — gera código 4 dígitos único para pedido

### Fase Bot-3: Geração de `codigo_entrega`
- Ao despachar um pedido (status → `em_rota`), o servidor gera e salva `codigo_entrega`
- Código é enviado ao cliente via WhatsApp pelo CEIA_OS (não pelo bot)
- Bot só recebe o código e executa `processarBaixaRelacional`

### Fase Bot-4: Reescrita do bot em JavaScript
- Novo arquivo `src/bot/telegram.js` no CEIA_OS
- Usa Telegraf (instalar: `npm i telegraf`)
- Importa funções do `db.js`
- Inicia via `iniciarTelegram()` chamado no `server.js` ao subir
- Substitui completamente o `Downloads/frota.ceia/telegramBot.ts`

### Fase Bot-5: Integração Despacho ↔ Bot
- Ao criar pacote com status `aguardando_coleta` e motoboy atribuído: chama `enviarConviteRotaTelegram(telegram_id, texto, pacoteId)`
- Ao aceite: bot atualiza `pacotes.status = 'em_rota'` + `motoboys.operacional_status = 'EM_ROTA'`
- Ao recusa: bot reverte `pacotes.status = 'aguardando_coleta'` + `pacotes.motoboy_id = NULL`
- UI Despacho recebe via SSE (evento `ACEITE_ROTA` / `RECUSA_ROTA`)

---

## PASSO 6 — Riscos e decisões pendentes

### Risco A — GPS em tempo real (ALTO)
**Problema:** O bot Frota CEIA atualiza `lat/lng` via Telegram location events, mas o CEIA_OS não tem um canal de push eficiente para o frontend. O SSE atual só transmite eventos de negócio (novo pedido, baixa), não streams de GPS.

**Solução necessária:** Adicionar evento SSE `GPS_UPDATE` com `{motoboy_id, lat, lng}` e um mapa ao vivo na tela de Despacho ou Motoboys. Alternativa mais simples: o frontend faz polling em `/api/fleet` a cada 10s.

### Risco B — Nuvem cross-store (ALTO)
**Problema:** Motoboys Freelancer se registram na API externa `frota.ceia.ia.br/wp-json/frota/v1/cadastrar_freelancer`. Quando uma loja precisa de motoboy extra, chama essa API e recebe um `telegram_id` de outro estabelecimento.

**Decisão necessária:** O CEIA_OS vai integrar com essa API? Ou a funcionalidade Nuvem fica fora do escopo inicial?

**Risco associado:** Se um motoboy Nuvem de outra loja aceitar rota no CEIA_OS, ele aparece na `motoboys` local com `vinculo='Nuvem'`. Ao finalizar, `deletarMotoboByTelegramId` remove esse registro — isso é correto. Mas o `telegram_id` pode colidir com o de outra loja (mesmo `telegram_id`, duas instâncias do CEIA_OS).

### Risco C — `codigo_entrega` de 4 dígitos: colisão (MÉDIO)
**Problema:** O Frota CEIA não documenta como gera o código de 4 dígitos (`pedido.codigo_entrega` nos blobs). Um código curto pode colidir entre dois pedidos ativos simultâneos do mesmo motoboy.

**Mitigação:** A `processarBaixaRelacional` deve checar `motoboy_id` + `codigo_entrega` + `status = 'em_rota'` juntos. Mesmo que dois pedidos tenham o mesmo código, a dupla (motoboy, código) é quase única na prática (motoboy raramente tem dois pedidos com mesmo código ativo).

**Implementação sugerida:**
```javascript
function gerarCodigoEntrega() {
  return String(Math.floor(1000 + Math.random() * 9000));
}
// Verificar unicidade: SELECT id FROM pedidos WHERE codigo_entrega = ? AND status = 'em_rota'
```

### Risco D — IDs TEXT (Frota) vs INTEGER (CEIA_OS) (MÉDIO)
**Problema:** O Frota CEIA usa UUIDs/timestamps como IDs de pedidos e pacotes (TEXT). O CEIA_OS usa AUTOINCREMENT INTEGER. Se algum dado for migrado do banco do Frota CEIA para o CEIA_OS, os IDs são incompatíveis.

**Mitigação:** Não migrar dados históricos do Frota CEIA. O bot novo começa do zero com os dados do CEIA_OS. Os pedidos/pacotes existentes no `frota.ceia/database.sqlite` são descartados.

### Risco E — Campo `whatsapp` vs `cpf` no `motoboys` (BAIXO)
**Problema:** O Frota CEIA armazena o número de WhatsApp do motoboy na coluna `cpf` (herança de refactoring). O CEIA_OS tem colunas separadas `whatsapp` e `cpf`. O bot precisa ser explícito: gravar número de telefone em `whatsapp`, CPF real em `cpf`.

**Ação:** Na entrevista do bot, renomear o passo `WHATSAPP` para coletar e gravar corretamente em `motoboys.whatsapp`. Não usar `cpf` como alias.

### Risco F — Status duplo: `status` administrativo vs `operacional_status` (BAIXO)
**Problema:** O Frota CEIA usa uma única coluna `status` para tudo (ONLINE, OFFLINE, EM_ENTREGA, CADASTRANDO). O CEIA_OS dividiu:
- `motoboys.status` = 'ativo' / 'inativo' (administrativo, alterado pelo operador via UI)
- `motoboys.operacional_status` = 'ONLINE' / 'OFFLINE' / 'EM_ROTA' (operacional, alterado pelo bot)

**Ação:** No bot reescrito, mapear explicitamente:
- `upsertFleet({status:'ONLINE'})` → `UPDATE motoboys SET operacional_status = 'ONLINE'`
- `upsertFleet({status:'CADASTRANDO'})` → `UPDATE motoboys SET operacional_status = 'OFFLINE'` (motoboy ainda não está ativo)
- A coluna `status` administrativa nunca é tocada pelo bot

---

---

## PASSO 7 — API Nuvem (investigado em 2026-05-20)

### 7.1 Arquitetura geral

A Nuvem é uma rede P2P de lojas + um Hub central hospedado em `frota.ceia.ia.br`. Cada loja é um "nó" que:
1. Publica seus motoboys ONLINE no Hub a cada 2 minutos (sincronização GPS)
2. Consulta o Hub para buscar motoboys disponíveis de outras lojas
3. Envia convites diretamente para o nó da loja de origem do motoboy (P2P, não via Hub)

O Hub é um WordPress com plugin personalizado. Não há SDK — são chamadas `fetch` diretas.

### 7.2 Variáveis de ambiente

| Variável | Valor default | Uso |
|---|---|---|
| `HUB_URL` | `undefined` (sem default) | URL base do Hub Central |
| `LOJA_URL` | `''` | URL pública desta loja (usada como `no_url` no Hub) |

Se `HUB_URL` não estiver configurado, o Hub sync simplesmente não roda (sem crash).

### 7.3 Endpoints chamados pelo sistema

#### A. Registrar Freelancer no Hub
**Chamado em:** `telegramBot.ts` ao final do cadastro, se `vinculo === 'Freelancer'`

```
POST https://frota.ceia.ia.br/wp-json/frota/v1/cadastrar_freelancer
Content-Type: application/json
(sem autenticação)

Body: {
  telegram_id: string,
  nome: string,
  whatsapp: string | null,
  pix: string | null,
  veiculo: string
}
```
Fire-and-forget (`.catch()` silencioso). Resposta ignorada.

#### B. Buscar motoboys disponíveis
**Chamado em:** `GET /api/frota-compartilhada/buscar` (frontend solicita)

```
GET ${HUB_URL}/buscar?lat=<lat>&lng=<lng>
(sem autenticação)
Timeout: 8s

Resposta esperada: array de {telegram_id, nome, veiculo, lat, lng, no_url, no_nome}
```
O Hub retorna Freelancers ONLINE próximos (critério de "próximo" é do Hub). `no_url` é a URL do nó onde o motoboy está cadastrado. Valor especial `no_url = 'GLOBAL'` indica motoboy global (sem nó fixo).

#### C. Sincronização GPS no Hub
**Chamado em:** `setInterval` a cada 2 minutos, para cada motoboy ONLINE com GPS válido

```
POST ${HUB_URL}/sync
Content-Type: application/json
(sem autenticação)
Timeout: 5s

Body: {
  telegram_id: string,
  nome: string,
  lat: number,
  lng: number,
  no_url: string,    -- URL pública desta loja
  no_nome: string    -- nome desta loja
}
```
Fire-and-forget. Condição: só sincroniza motoboys `ONLINE` com lat/lng preenchidos. Motoboys `Nuvem` sempre sincronizam; motoboys `Fixo`/`Freelancer` só sincronizam **fora do expediente** (para disponibilização cross-loja).

#### D. Endpoint público que esta loja expõe ao Hub (leitura)
```
GET /api/frota-compartilhada/disponiveis
(sem autenticação — endpoint público)

Resposta: [{telegram_id, nome, veiculo, lat, lng}]
```
Retorna motoboys locais ONLINE com GPS. Só responde fora do expediente (durante expediente retorna `[]`).

### 7.4 Fluxo de convite Nuvem (ponta a ponta)

```
1. Operador na UI clica "Chamar Nuvem"
2. UI: GET /api/frota-compartilhada/buscar
       → sistema chama Hub: GET ${HUB_URL}/buscar?lat=&lng=
       → Hub retorna: [{telegram_id, no_url, no_nome, ...}]

3. Operador seleciona um motoboy
4. UI: POST /api/frota-compartilhada/convidar
       Body: {telegram_id, no_url, no_nome, pacoteId, pedidos, taxa_deslocamento_brl, distancia_km}

5a. Se no_url === 'GLOBAL':
    → Bot local chama repassarConviteNuvem(telegram_id, {...})
    → Motoboy recebe mensagem Telegram com botões [✅ Aceitar] [❌ Recusar]
    → Botão "Aceitar" usa aceitar_nuvem_<pacoteId> (bot local mesmo)

5b. Se no_url é URL de outro nó:
    → POST ${no_url}/api/frota-compartilhada/repassar-convite
       Body: {telegram_id, loja_nome, loja_bot_link, taxa_..., pacote_id, no_url, no_nome}
    → Nó remoto chama seu próprio bot: repassarConviteNuvem(telegram_id, {...})
    → Motoboy recebe mensagem no bot da loja de ORIGEM com botões
    → Botão "Aceitar Rota" abre link para bot DESTA loja: https://t.me/<bot>?start=nuvem_<pacoteId>

6. Motoboy clica Aceitar:
    → No caso P2P: bot desta loja recebe /start nuvem_<pacoteId>
    → upsertFleet({telegram_id, vinculo:'Nuvem', status:'CADASTRANDO'})
    → Bot pede Localização em Tempo Real
    → Ao receber GPS: pacote.status = 'EM_ROTA', motoboy.status = 'EM_ENTREGA'
    → Envia detalhes da rota ao motoboy
    → Envia WhatsApp ao cliente com código de baixa

7. Motoboy digita código de 4 dígitos:
    → processarBaixaPeloTelegram → registrarEntrega → deletePedido/savePacote

8. Pagamento:
    → Operador clica "Acertar" na UI
    → enviarConfirmacaoPagamento(telegram_id, motoboyId, valorTotal)
    → Motoboy confirma: deletarMotoboy(telegram_id) — removido da frota local
```

### 7.5 Colunas necessárias no CEIA_OS para Nuvem

As seguintes colunas (ausentes no Fase 9) foram identificadas como necessárias e já adicionadas na Fase Bot-1:

| Coluna | Tabela | Uso |
|---|---|---|
| `no_url TEXT` | `motoboys` | URL do nó de origem do motoboy Nuvem |
| `taxa_deslocamento REAL` | `motoboys` | Taxa acordada para o deslocamento até a loja |
| `distancia_km REAL` | `motoboys` | Distância calculada do motoboy à loja |

### 7.6 Autenticação

**Não há autenticação nas chamadas do Hub.** O Hub confia no `no_url` enviado no body para identificar a loja. O endpoint `/api/frota-compartilhada/repassar-convite` desta loja também é público (sem JWT). Qualquer um com a URL pode enviar um convite.

**Implicação para o CEIA_OS:** Ao implementar `/api/frota-compartilhada/repassar-convite`, manter como endpoint público (sem JWT). Validar minimamente o body (telegram_id e loja_nome presentes).

### 7.7 Tabela `entregas` e Nuvem

A tabela `entregas` implementada na Fase Bot-1 suporta Nuvem nativamente:
- Motoboy local: `motoboy_id = <id>`, `motoboy_telegram_id = <tid>`, `origem = 'local'`
- Motoboy Nuvem: `motoboy_id = NULL`, `motoboy_telegram_id = <tid>`, `origem = 'nuvem'`, `no_origem = <no_nome>`

Isso permite registrar e pagar entregas Nuvem sem precisar cadastrar o motoboy permanentemente na tabela `motoboys`.

---

## Resumo de lacunas bloqueantes

| # | Lacuna | Tabela/coluna | Impacto |
|---|---|---|---|
| 1 | `pedidos.codigo_entrega` ausente | ALTER TABLE | Baixa pelo bot impossível sem isso |
| 2 | `tokens_cadastro` ausente | CREATE TABLE | Convite QR / fluxo `/start` com token impossível |
| 3 | `UNIQUE INDEX motoboys.telegram_id` ausente | CREATE INDEX | Upsert por telegram_id pode criar duplicatas |
| 4 | Função `getMotoboyByTelegramId` ausente | db.js | Bot não consegue verificar cadastro existente |
| 5 | Função `processarBaixaRelacional` ausente | db.js | Baixa da entrega impossível |
| 6 | Telegraf não instalado | package.json | `npm i telegraf` necessário |
| 7 | Bot não inicializado no server.js | server.js | Bot nunca sobe junto com o servidor |

**Lacunas não-bloqueantes (têm workaround):**
- `entregas` table → usa `saldo_acerto` agregado no motoboy (menos granular)  
- `historico_motoboys` table → usa JOIN em pedidos/pacotes (Fase 9 já implementado)
- GPS push → usa polling no frontend
