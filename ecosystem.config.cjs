// pm2 ecosystem — run both apps with: pm2 start ecosystem.config.cjs
// Restart individually:  pm2 restart tw-dashboard | pm2 restart tw-autopilot
//
// Only MONGODB_URI is required in .env.local (or passed via env below).
// Everything else (credentials, company ID, API URL) is stored in MongoDB
// after the first dashboard login + company selection.

module.exports = {
  apps: [
    {
      name: "tw-dashboard",
      script: "./node_modules/.bin/next",
      args: "start",
      env_file: ".env.local",
      env: {
        NODE_ENV: "production",
      },
      watch: false,
      autorestart: true,
      restart_delay: 3000,
    },
    {
      name: "tw-autopilot",
      script: "node",
      args: "--env-file=.env.local --import tsx src/workers/autopilot-standalone.ts",
      env: {
        NODE_ENV: "production",
      },
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      // Logs go to ~/.pm2/logs/tw-autopilot-out.log
    },
  ],
};
