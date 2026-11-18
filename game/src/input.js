// Keyboard and mouse input. Held keys give movement axes (the same keys walk Rio and drive
// his car: WASD or the arrows, Shift to run, F or E to get in and out of cars); the mouse aims
// and fires the pistol. One-shot presses (menus, pause, mute, entering a car) are queued as
// bit flags and taken once by the loop, so a press between two frames is never lost and never
// counted twice. Nothing here knows about the world: main.js turns this into the input struct
// world.step consumes, including the aim angle it derives from the mouse and the camera.

export const ACTION_CONFIRM = 1;
export const ACTION_PAUSE = 2;
export const ACTION_ENTER = 4;
export const ACTION_MUTE = 8;
export const ACTION_UP = 16;
export const ACTION_DOWN = 32;

const UP = new Set(['ArrowUp', 'KeyW']);
const DOWN = new Set(['ArrowDown', 'KeyS']);
const LEFT = new Set(['ArrowLeft', 'KeyA']);
const RIGHT = new Set(['ArrowRight', 'KeyD']);
const GAME_KEYS = new Set([...UP, ...DOWN, ...LEFT, ...RIGHT, 'Space', 'ShiftLeft', 'ShiftRight', 'KeyF', 'KeyE', 'KeyP', 'KeyM', 'Escape', 'Enter']);

export function createInput(target) {
  const held = new Set();
  const mouse = { x: 0, y: 0, down: false };
  let actions = 0;

  window.addEventListener('keydown', (event) => {
    if (!GAME_KEYS.has(event.code)) return;
    held.add(event.code);
    if (!event.repeat) {
      if (event.code === 'Space' || event.code === 'Enter') actions |= ACTION_CONFIRM;
      else if (event.code === 'KeyP' || event.code === 'Escape') actions |= ACTION_PAUSE;
      else if (event.code === 'KeyF' || event.code === 'KeyE') actions |= ACTION_ENTER;
      else if (event.code === 'KeyM') actions |= ACTION_MUTE;
      else if (UP.has(event.code)) actions |= ACTION_UP;
      else if (DOWN.has(event.code)) actions |= ACTION_DOWN;
    }
    event.preventDefault();
  });
  window.addEventListener('keyup', (event) => {
    held.delete(event.code);
  });
  // Keys released while the tab is hidden never send keyup: let go of everything on blur.
  window.addEventListener('blur', () => {
    held.clear();
    mouse.down = false;
  });
  target.addEventListener('pointermove', (event) => {
    const rect = target.getBoundingClientRect();
    mouse.x = event.clientX - rect.left;
    mouse.y = event.clientY - rect.top;
  });
  target.addEventListener('pointerdown', (event) => {
    mouse.down = true;
    mouse.x = event.clientX - target.getBoundingClientRect().left;
    mouse.y = event.clientY - target.getBoundingClientRect().top;
    actions |= ACTION_CONFIRM;
  });
  window.addEventListener('pointerup', () => {
    mouse.down = false;
  });
  target.addEventListener('contextmenu', (event) => event.preventDefault());

  function anyHeld(set) {
    for (const code of set) if (held.has(code)) return true;
    return false;
  }

  return {
    /** On-foot axes, -1..1 each. */
    axisX() {
      return (anyHeld(RIGHT) ? 1 : 0) - (anyHeld(LEFT) ? 1 : 0);
    },
    axisY() {
      return (anyHeld(DOWN) ? 1 : 0) - (anyHeld(UP) ? 1 : 0);
    },
    /** Driving: 1 forward, -1 brake/reverse. */
    throttle() {
      return (anyHeld(UP) ? 1 : 0) - (anyHeld(DOWN) ? 1 : 0);
    },
    /** Driving: -1 left, 1 right. */
    steer() {
      return (anyHeld(RIGHT) ? 1 : 0) - (anyHeld(LEFT) ? 1 : 0);
    },
    run() {
      return held.has('ShiftLeft') || held.has('ShiftRight');
    },
    /** Pistol trigger: mouse held, or Space held (aim then follows the walk direction). */
    firing() {
      return mouse.down || held.has('Space');
    },
    mouseDown() {
      return mouse.down;
    },
    mousePos() {
      return mouse;
    },
    /** The one-shot presses since the last call, as ACTION_* flags. */
    takeActions() {
      const taken = actions;
      actions = 0;
      return taken;
    },
  };
}
