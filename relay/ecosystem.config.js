module.exports = {
  apps: [{
    name:        'remote-tmux-relay',
    script:      'server.js',
    cwd:         '/home/remotes/remote-tmux/relay',
    instances:   1,
    autorestart: true,
    watch:       false,
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production',
    },
    error_file: '/home/remotes/remote-tmux/logs/relay-error.log',
    out_file:   '/home/remotes/remote-tmux/logs/relay-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
