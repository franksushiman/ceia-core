let sockInstance = null;

function setSocket(sock) {
  sockInstance = sock;
}

async function sendMessage(to, text) {
  if (!sockInstance) {
    console.log("⚠️ Socket não inicializado.");
    return;
  }

  await sockInstance.sendMessage(to, { text });
}

module.exports = {
  setSocket,
  sendMessage,
};
