// pm2 ecosystem — run with: pm2 start ecosystem.config.cjs
// Restart: pm2 restart tw-dashboard
//
// The dashboard runs the fleet autopilot in-process, so it is the only app.
// Sign in, pick a company and press Start once; the autopilot resumes on every restart after that.
// Company API keys and autopilot settings live in .kibb/store.json (gitignored). No database needed.
//
// Build first: pnpm build

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
  ],
};
