// Keyboard and pointer input. Held keys give the two movement axes; one-shot presses
// (confirm, pause, interact, mute, menu steps) are queued as bit flags and taken once by
// the loop, so a press between two frames is never lost and never counted twice.
export const ACTION_CONFIRM = 1;
export const ACTION_PAUSE = 2;
export const ACTION_INTERACT = 4;
export const ACTION_MUTE = 8;

const LEFT = new Set(['ArrowLeft', 'KeyA']);
const RIGHT = new Set(['ArrowRight', 'KeyD']);
const UP = new Set(['ArrowUp', 'KeyW']);
const DOWN = new Set(['ArrowDown', 'KeyS']);
const RUN = new Set(['ShiftLeft', 'ShiftRight']);
const CONFIRM = new Set(['Space', 'Enter']);
const PAUSE = new Set(['KeyP', 'Escape']);
const INTERACT = new Set(['KeyF', 'KeyE']);
const MUTE = new Set(['KeyM']);
const GAME_KEYS = new Set([...LEFT, ...RIGHT, ...UP, ...DOWN, ...CONFIRM, ...PAUSE, ...INTERACT]);

export function createInput(target) {
  const held = { left: false, right: false, up: false, down: false, run: false, space: false };
  let actions = 0;
  let nav = 0; // queued menu steps: -1 up, +1 down
  const mouse = { x: 0, y: 0, down: false };

  window.addEventListener('keydown', (event) => {
    if (LEFT.has(event.code)) held.left = true;
    else if (RIGHT.has(event.code)) held.right = true;
    else if (UP.has(event.code)) {
      held.up = true;
      if (!event.repeat) nav -= 1;
    } else if (DOWN.has(event.code)) {
      held.down = true;
      if (!event.repeat) nav += 1;
    } else if (RUN.has(event.code)) held.run = true;
    else if (CONFIRM.has(event.code)) {
      if (event.code === 'Space') held.space = true;
      if (!event.repeat) actions |= ACTION_CONFIRM;
    } else if (PAUSE.has(event.code)) {
      if (!event.repeat) actions |= ACTION_PAUSE;
    } else if (INTERACT.has(event.code)) {
      if (!event.repeat) actions |= ACTION_INTERACT;
    } else if (MUTE.has(event.code)) {
      if (!event.repeat) actions |= ACTION_MUTE;
    } else return;
    if (GAME_KEYS.has(event.code)) event.preventDefault();
  });
  window.addEventListener('keyup', (event) => {
    if (LEFT.has(event.code)) held.left = false;
    else if (RIGHT.has(event.code)) held.right = false;
    else if (UP.has(event.code)) held.up = false;
    else if (DOWN.has(event.code)) held.down = false;
    else if (RUN.has(event.code)) held.run = false;
    else if (event.code === 'Space') held.space = false;
  });
  // A key released while the tab is hidden never sends keyup: let go of everything on blur.
  window.addEventListener('blur', () => {
    held.left = false;
    held.right = false;
    held.up = false;
    held.down = false;
    held.run = false;
    held.space = false;
    mouse.down = false;
  });
  target.addEventListener('pointermove', (event) => {
    mouse.x = event.clientX;
    mouse.y = event.clientY;
  });
  target.addEventListener('pointerdown', (event) => {
    mouse.x = event.clientX;
    mouse.y = event.clientY;
    mouse.down = true;
    actions |= ACTION_CONFIRM;
  });
  window.addEventListener('pointerup', () => {
    mouse.down = false;
  });

  return {
    /** Held movement axes in screen terms: x right, y down, each -1..1. */
    axes() {
      return {
        x: (held.right ? 1 : 0) - (held.left ? 1 : 0),
        y: (held.down ? 1 : 0) - (held.up ? 1 : 0),
      };
    },
    run() { return held.run; },
    /** Firing is the mouse button or a held Space. */
    fire() { return mouse.down || held.space; },
    mouse,
    /** The one-shot presses since the last call, as ACTION_* flags. */
    takeActions() {
      const taken = actions;
      actions = 0;
      return taken;
    },
    /** Queued menu steps since the last call (-1 per Up press, +1 per Down press). */
    takeNav() {
      const taken = nav;
      nav = 0;
      return taken;
    },
  };
}
