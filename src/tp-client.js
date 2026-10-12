'use strict';

const EventEmitter = require('events');
const net = require('net');
const fs = require('fs');
const path = require('path');

// Minimal Touch Portal plugin socket client, written from the Touch Portal
// API docs (touch-portal.com/api, "Communication" sections).
//
// Why hand-written: the community package touchportal-api (4.0.0 and 3.3.0)
// runs `tsc` in an install script and cannot be installed from npm without
// TypeScript, so it is not usable as a plain dependency.
//
// Protocol summary:
// - TCP to 127.0.0.1:12136, UTF-8, one JSON object per line ("\n").
// - First message: {"type":"pair","id":"<pluginId>"}; Touch Portal answers
//   with {"type":"info", ...settings...}.
//
// Events emitted (one per incoming message type):
//   'info' msg, 'settings' values, 'action' msg, 'up' msg, 'down' msg,
//   'listChange' msg, 'connectorChange' msg, 'shortConnectorIdNotification' msg,
//   'broadcast' msg, 'notificationOptionClicked' msg, 'closePlugin' msg,
//   'message' msg (anything else), plus 'connected', 'disconnected', 'error'.

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 12136;

const INCOMING = new Set([
  'info', 'action', 'up', 'down', 'listChange', 'connectorChange',
  'shortConnectorIdNotification', 'broadcast', 'notificationOptionClicked', 'closePlugin',
]);

class TouchPortalClient extends EventEmitter {
  constructor({ pluginId, host = DEFAULT_HOST, port = DEFAULT_PORT, logger = null }) {
    super();
    if (!pluginId) throw new Error('pluginId is required');
    this.pluginId = pluginId;
    this.host = host;
    this.port = port;
    this.log = logger;
    this.socket = null;
    this.buffer = '';
  }

  connect() {
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.on('connect', () => {
      this.emit('connected');
      this.send({ type: 'pair', id: this.pluginId });
    });
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.emit('error', err));
    socket.on('close', (hadError) => {
      this.socket = null;
      this.emit('disconnected', hadError);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (this.log) this.log.warn(`Ignoring malformed message from Touch Portal (${line.length} chars)`);
      return;
    }
    const type = msg && msg.type;
    if (type === 'settings') {
      this.emit('settings', msg.values);
    } else if (type === 'closePlugin') {
      if (!msg.pluginId || msg.pluginId === this.pluginId) this.emit('closePlugin', msg);
    } else if (INCOMING.has(type)) {
      this.emit(type, msg);
    } else {
      this.emit('message', msg);
    }
  }

  get isOpen() {
    return Boolean(this.socket && !this.socket.destroyed && this.socket.writable);
  }

  send(obj) {
    if (!this.isOpen) throw new Error('Not connected to Touch Portal');
    this.socket.write(`${JSON.stringify(obj)}\n`);
  }

  disconnect() {
    if (this.socket && !this.socket.destroyed) this.socket.end();
  }
}

// Touch Portal docs: when "external computer connection" is used, 127.0.0.1
// will not work and the plugin needs a way to change the address before it
// can talk to Touch Portal. An optional connection.json in the plugin folder
// does that: {"host": "192.168.0.10", "port": 12136}
function loadConnectionConfig(pluginDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(pluginDir, 'connection.json'), 'utf8'));
    const port = Number.parseInt(raw.port, 10);
    return {
      host: typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim() : DEFAULT_HOST,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    };
  } catch {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT };
  }
}

module.exports = { TouchPortalClient, loadConnectionConfig, DEFAULT_HOST, DEFAULT_PORT };
