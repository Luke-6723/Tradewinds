// pm2 ecosystem — build first (pnpm build), then: pm2 start ecosystem.config.cjs
// Restart: pm2 restart tw-dashboard        Logs: pm2 logs tw-dashboard
//
// The dashboard runs the fleet autopilot in-process for every company you press Start on, so it
// is the only app: one process trades all your companies, and each resumes on every restart.
// Company API keys and autopilot settings live in .kibb/store.json (gitignored); Next.js reads
// .env.local itself (KIBB_API_URL, KIBB_STORE_DIR, TOPSTATS_API_KEY). No database needed.
//
// Scripts point at the JS entry points, not node_modules/.bin shims, so this also runs on Windows.

module.exports = {
  apps: [
    {
      name: "tw-dashboard",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      interpreter: "node",
      args: "start -p 7899",
      env: {
        NODE_ENV: "production",
      },
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      kill_timeout: 10000, // lets the autopilot finish its current call and release its lease
    },

    // Headless alternative for one company, without the dashboard. Don't run both for the same
    // company: the lease file stops the second one. Needs KIBB_API_KEY (a company-bound key) in
    // .env.local; see src/workers/kibb-fleet.ts for the other settings.
    // {
    //   name: "tw-fleet",
    //   cwd: __dirname,
    //   script: "node_modules/tsx/dist/cli.mjs",
    //   interpreter: "node",
    //   args: "--env-file=.env.local src/workers/kibb-fleet.ts",
    //   env: { NODE_ENV: "production" },
    //   watch: false,
    //   autorestart: true,
    //   restart_delay: 5000,
    // },
  ],
};
