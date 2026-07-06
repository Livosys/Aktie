'use strict';

const assert = require('assert/strict');
const svc = require('./interactiveBrokersGatewayHealthService');

function run() {
  assert.deepEqual(svc.SAFETY, {
    mode: 'paper_only',
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  });

  assert.equal(svc._internal.buildNextAction({
    gatewayProcessRunning: true,
    apiPortOpen: true,
    authenticated: true,
    connected: true,
  }), 'Allt ser OK ut');

  assert.equal(svc._internal.buildNextAction({
    gatewayProcessRunning: false,
    apiPortOpen: false,
    authenticated: false,
    connected: false,
  }), 'IB Gateway verkar inte vara startad');

  assert.equal(svc._internal.buildNextAction({
    gatewayProcessRunning: true,
    apiPortOpen: false,
    authenticated: false,
    connected: false,
  }), 'IB Gateway kör men API svarar inte');

  assert.equal(svc._internal.buildNextAction({
    gatewayProcessRunning: true,
    apiPortOpen: true,
    authenticated: false,
    connected: false,
  }), 'Manuell IBKR-login krävs');

  assert.equal(svc._internal.sanitizeCommand('/home/ibgateway/ibgateway/ibgateway'), '/home/ibgateway/ibgateway/ibgateway');
  assert.equal(svc._internal.sanitizeCommand('/home/ibgateway/ibgateway/ibgateway --password=secret'), null);
  assert.equal(svc._internal.sanitizeCommand('/usr/bin/vncserver :2'), null);

  const rows = svc._internal.parseProcessRows('123 ibgateway /home/ibgateway/ibgateway/ibgateway\n456 root /usr/bin/Xtigervnc :2\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pid, 123);
  assert.equal(rows[0].user, 'ibgateway');

  const ports = svc._internal.parseListeningPorts('LISTEN 0 5 127.0.0.1:5902 0.0.0.0:*\nLISTEN 0 5 127.0.0.1:4002 0.0.0.0:*\n');
  assert.equal(ports.has(5902), true);
  assert.equal(ports.has(4002), true);

  console.log('interactiveBrokersGatewayHealthService.test.js: OK');
}

run();
