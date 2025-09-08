// PM2 Configuration for VPS Deployment
module.exports = {
  apps: [
    {
      name: 'socketio-main',
      script: 'server.js',
      instances: 'max', // Use all CPU cores
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        SOCKETIO_PORT: 3001,
        SERVER_ID: 'socketio-main',
        REDIS_HOST: 'localhost',
        REDIS_PORT: 6379
      },
      env_production: {
        NODE_ENV: 'production',
        SOCKETIO_PORT: 3001,
        SERVER_ID: 'socketio-prod'
      },
      // Performance & Monitoring
      max_memory_restart: '1G',
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000,
      
      // Logging
      log_file: './logs/combined.log',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      
      // Auto-restart configuration
      watch: false,
      ignore_watch: ['node_modules', 'logs'],
      max_restarts: 10,
      min_uptime: '10s'
    }
  ]
};