// Integration fixture for the Rust transport tests (not a node:test suite).
process.env.PORT = '0';
process.env.PASSWORD = '';
const server = require('../src/index');
server.httpServer.once('listening', () => console.log(`TEST_PORT:${server.httpServer.address().port}`));
server.io.on('connection', socket => {
  socket.on('test_transport_drop', () => socket.conn.close());
  socket.on('test_drop_reply', filter => { socket.dropReply = filter; });
  socket.on('protocol_request', request => {
    if (socket.dropReply?.method === request.method && socket.dropReply.index === request.body?.index) {
      socket.dropReplyId = request.id;
      socket.dropReply = null;
    }
  });
  const emit = socket.emit.bind(socket);
  socket.emit = (event, data, ...rest) => {
    if (event === 'protocol_reply' && data.id === socket.dropReplyId) {
      socket.dropReplyId = null;
      socket.conn.close();
      return socket;
    }
    return emit(event, data, ...rest);
  };
});
process.stdin.resume();
process.stdin.once('end', () => server.shutdown().then(() => process.exit(0)));
