const path = require('path');
const Service = require('node-windows').Service;

const backendScript = path.join(__dirname, 'index.js');
const logFile = path.join(__dirname, 'backend.log');

const svc = new Service({
  name: 'POS Backend',
  description: 'Backend server untuk POS Electron',
  script: backendScript,
  nodeOptions: ['--harmony', '--max_old_space_size=4096'],
  workingDirectory: __dirname,
  stdout: logFile,
  stderr: logFile,
});

svc.on('install', () => {
  svc.start();
  console.log('✅ Service installed and started.');
});

svc.on('alreadyinstalled', () => console.log('ℹ Service already installed.'));
svc.on('start', () => console.log('✅ Service started.'));
svc.on('stop', () => console.log('ℹ Service stopped.'));
svc.on('error', (err) => console.error('❌ Service error:', err));

svc.install();
