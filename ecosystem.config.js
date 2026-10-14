module.exports = {
  apps: [
    {
      name: "speedmoney-backend",
      script: "server.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 5000,
      },
      env_file: ".env",
      max_memory_restart: "500M",
      error_file: "logs/err.log",
      out_file: "logs/out.log",
      log_file: "logs/combined.log",
      time: true,
      restart_delay: 3000,
    },
  ],
};
