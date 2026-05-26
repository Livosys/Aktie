'use strict';

module.exports = {
  apps: [
    {
      name: 'nasdaq-scanner',
      script: 'server.js',
      cwd: '/var/www/nasdaq-scanner',
      instances: 1,
      exec_mode: 'fork',

      // Restart if heap grows beyond 1.5 GB
      max_memory_restart: '1500M',

      // Restart policy
      restart_delay: 4000,
      max_restarts: 10,
      min_uptime: '10s',

      // Logs
      out_file: '/var/log/pm2/nasdaq-scanner-out.log',
      error_file: '/var/log/pm2/nasdaq-scanner-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      // Keep 10 MB per log file, rotate daily
      log_type: 'json',

      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        REDIS_URL: 'redis://127.0.0.1:6379',
      },
    },
  ],
};
