import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/browser', timeout:30000, fullyParallel:false, workers:1,
  forbidOnly:!!process.env.CI, retries:process.env.CI?1:0,
  reporter:[['list'],['html',{open:'never'}]],
  use:{baseURL:'http://127.0.0.1:4173/ios-pwa-lab/',viewport:{width:390,height:844},hasTouch:true,trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'chromium',use:{browserName:'chromium'}},{name:'webkit',use:{browserName:'webkit'}}],
  webServer:{command:'node tools/server.mjs',url:'http://127.0.0.1:4173/ios-pwa-lab/',reuseExistingServer:!process.env.CI},
});
