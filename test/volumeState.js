'use strict';

// The answer of a faked Recycle Bin state check (#376). The check has two shapes: one path in FC_VOLUME (recycleBinState) and several paths joined by | in
// FC_VOLUMES (recycleBinStates, one answer line per path, in order). lineFor(path) gives the line for one path. It returns undefined when the call is not a state check,
// so a fake writes:  const state = volumeStateAnswer(options?.env, () => 'True|Fixed\r\n'); if (state !== undefined) return state;

function volumeStateAnswer(env, lineFor) {
  if (!env) return undefined;
  if (env.FC_VOLUME !== undefined) return lineFor(env.FC_VOLUME);
  if (env.FC_VOLUMES !== undefined) return `${env.FC_VOLUMES.split('|').map((p) => String(lineFor(p)).replace(/\r?\n$/, '')).join('\r\n')}\r\n`;
  return undefined;
}

module.exports = { volumeStateAnswer };
