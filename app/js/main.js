import * as lib from './library.js';
import { Stage } from './scene.js';
import { Builder } from './builder.js';
import { newId, IDENTITY } from './ldr.js';

const $ = s => document.querySelector(s);

async function boot() {
  await lib.init();
  const stage = new Stage($('#view'));
  const builder = new Builder(stage);
  window.app = { lib, stage, builder };
  await builder.load({
    name: 'Untitled',
    parts: [
      { id: newId(), file: '3867.dat', color: 2, pos: [0, 0, 0], rot: [...IDENTITY], step: 0 },
      { id: newId(), file: '3001.dat', color: 4, pos: [0, -24, 0], rot: [...IDENTITY], step: 1 },
    ],
    submodels: [],
  });
  $('#loading').hidden = true;
  window.appReady = true;
}

boot().catch(e => {
  console.error(e);
  $('#loading-text').textContent = 'Could not start: ' + e.message;
});
