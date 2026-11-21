'use strict';

// "1 file", "2 files". The shared way reports write a count with its noun (#332). plural is the form for any count other than 1 (default: word + "s").
function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

module.exports = { plural };
