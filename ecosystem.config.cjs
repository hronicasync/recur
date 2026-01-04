module.exports = {
  apps: [
    {
      name: 'recur-bot',
      script: './node.js',
      cwd: __dirname,
      env_file: '.env',
      node_args: '--enable-source-maps',
      max_memory_restart: '256M',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'recur-reminder-worker',
      script: './reminderWorker.js',
      cwd: __dirname,
      env_file: '.env',
      node_args: '--enable-source-maps',
      max_memory_restart: '256M',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
