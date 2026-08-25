'use strict';

module.exports = {
  apps: [
    {
      name: 'nasdaq-scanner',
      script: 'server.js',
      // Katalogen den här filen ligger i. Stod tidigare hårdkodad på -prod,
      // vilket gjorde att ett start från release-katalogens EGEN ecosystem-fil
      // ändå startade -prod: backend med paper-taket 1 i stället för 10, och
      // en frontend från 13 aug helt utan AI Factory.
      cwd: '/var/www/nasdaq-scanner-release-d109135',
      instances: 1,
      exec_mode: 'fork',

      // Restart if RSS grows beyond 2.5 GB. The HistoricalEdge cache rebuild
      // at startup transiently spikes RSS to ~1.6-1.95 GB; a 1.5 GB ceiling
      // killed the process mid-startup and caused a max-memory-restart loop.
      max_memory_restart: '2560M',

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
        FUTURES_NATIVE_PROVIDER_ENABLED: 'true',
        IB_FUTURES_DATA_ENABLED: 'true',
        IBKR_PAPER_EXECUTION_ENABLED: 'true',
      },
    },
  ],
};
