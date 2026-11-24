'use strict';

// run (#400): a saved recipe, a list of whole-target fctl commands run in order on one target.
//
// Recipe file (JSON):
//   { "name": "tidy a download", "steps": [
//       { "command": "extract-all" },
//       { "command": "flatten" },
//       "normalize",
//       { "command": "remove-duplicates" }
//   ] }
// - A step is a command name, or { command, options? }. options is a list of option strings ("--include-lowercase", "--min-height=480").
// - Only the commands that take one target folder can be steps. `run` itself cannot.
// - --yes, --force, --permanent, --remove-archives, --dry-run and --help can never be set by a recipe. A remove-* step only previews (the list and the confirmation value),
//   so it must be the last step: the recipe stops there and the person runs the remove command with --yes=VALUE on their own.
// - The whole recipe is checked before any step runs.

const fs = require('node:fs');
const { FcError } = require('./commands');
const { COMMANDS, VALUE_FLAGS, misplacedFlagMessage } = require('./commandTable');
const { plural } = require('./plural');

const MAX_RECIPE_BYTES = 1024 * 1024;
const MAX_STEPS = 50;
// Options without a value that a step may carry. Options with a value are VALUE_FLAGS.
const SWITCHES = new Set(['include-lowercase', 'recursive']);
// Never set by a recipe: run decides --dry-run, and the rest would let a recipe delete or overwrite without a person looking at the list.
const FORBIDDEN = new Set(['yes', 'force', 'permanent', 'dry-run', 'help', 'remove-archives']);

const STEP_COMMANDS = new Set(COMMANDS.filter((command) => command.kind === 'whole' && command.name !== 'run').map((command) => command.name));
const CONFIRMED_COMMANDS = new Set(COMMANDS.filter((command) => command.yes).map((command) => command.name));

function describeStep(index, step) {
  return `Step ${index + 1}${typeof step?.command === 'string' ? ` (${step.command})` : ''}`;
}

function checkOptions(label, command, options) {
  if (options === undefined) return [];
  if (!Array.isArray(options) || options.some((option) => typeof option !== 'string')) throw new FcError(`${label}: "options" must be a list of strings such as ["--include-lowercase"].`);
  const flags = new Set();
  for (const option of options) {
    const match = /^--([a-z][a-z-]*)(=(.*))?$/s.exec(option);
    if (!match) throw new FcError(`${label}: "${option}" is not an option. Write options as --name or --name=VALUE.`);
    const [, name, , value] = match;
    if (FORBIDDEN.has(name)) {
      const why = name === 'dry-run' ? 'use fctl run --dry-run to preview a whole recipe' : name === 'remove-archives' ? 'it sends the original archives to the Recycle Bin without showing a list first, so run extract-all --remove-archives yourself' : 'a recipe never confirms, overwrites or deletes permanently';
      throw new FcError(`${label}: --${name} cannot be used in a recipe (${why}).`);
    }
    if (VALUE_FLAGS.has(name)) {
      if (value === undefined) throw new FcError(`${label}: attach a value to --${name}, like --${name}=VALUE.`);
    } else if (SWITCHES.has(name)) {
      if (value !== undefined) throw new FcError(`${label}: --${name} does not take a value.`);
    } else {
      throw new FcError(`${label}: unknown option --${name}.`);
    }
    flags.add(name);
  }
  const misplaced = misplacedFlagMessage(command, flags);
  if (misplaced !== undefined) throw new FcError(`${label}: ${misplaced}`);
  return options;
}

// It checks the recipe object and returns { name, steps: [{ command, options }] }. It does not touch files. A bad recipe raises an FcError that names the step.
function validateRecipe(recipe) {
  if (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe)) throw new FcError('The recipe must be a JSON object like { "steps": [ ... ] }.');
  const unknownKey = Object.keys(recipe).find((key) => key !== 'name' && key !== 'steps');
  if (unknownKey !== undefined) throw new FcError(`The recipe has an unknown field "${unknownKey}". Only "name" and "steps" are used.`);
  if (recipe.name !== undefined && typeof recipe.name !== 'string') throw new FcError('The recipe "name" must be text.');
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) throw new FcError('The recipe needs a non-empty "steps" list.');
  if (recipe.steps.length > MAX_STEPS) throw new FcError(`The recipe has ${recipe.steps.length} steps; at most ${MAX_STEPS} are allowed.`);
  const steps = recipe.steps.map((raw, index) => {
    const step = typeof raw === 'string' ? { command: raw } : raw;
    const label = describeStep(index, step);
    if (step === null || typeof step !== 'object' || Array.isArray(step)) throw new FcError(`${label}: a step is a command name or { "command": ..., "options": [...] }.`);
    const unknownField = Object.keys(step).find((key) => key !== 'command' && key !== 'options');
    if (unknownField !== undefined) throw new FcError(`${label}: unknown field "${unknownField}". Only "command" and "options" are used.`);
    if (typeof step.command !== 'string' || step.command === '') throw new FcError(`${label}: "command" must be the name of a command.`);
    if (!STEP_COMMANDS.has(step.command)) {
      const reason = step.command === 'run' ? 'a recipe cannot run another recipe' : 'only commands that take one target folder can be steps';
      throw new FcError(`${label}: "${step.command}" cannot be a step (${reason}). Steps can be: ${[...STEP_COMMANDS].join(', ')}.`);
    }
    return { command: step.command, options: checkOptions(label, step.command, step.options) };
  });
  const early = steps.findIndex((step, index) => CONFIRMED_COMMANDS.has(step.command) && index < steps.length - 1);
  if (early !== -1) {
    throw new FcError(`Step ${early + 1} (${steps[early].command}) only shows a list and a confirmation value, so it must be the last step. Run the remove command with --yes=VALUE yourself after the recipe.`);
  }
  return { name: recipe.name, steps };
}

// It reads and checks a recipe file. It does not run anything.
function loadRecipe(file) {
  if (typeof file !== 'string' || file.trim() === '' || file.includes('\0')) throw new FcError('Specify a recipe file.');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    throw new FcError(`Cannot read the recipe file: ${file} (${err.code ?? err.message})`);
  }
  if (!stat.isFile()) throw new FcError(`The recipe is not a file: ${file}`);
  if (stat.size > MAX_RECIPE_BYTES) throw new FcError(`The recipe file is too large (over ${MAX_RECIPE_BYTES} bytes): ${file}`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new FcError(`Cannot read the recipe file: ${file} (${err.code ?? err.message})`);
  }
  let recipe;
  try {
    recipe = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new FcError(`The recipe is not valid JSON: ${file} (${err.message})`);
  }
  return validateRecipe(recipe);
}

// It runs the recipe's steps in order on the target and stops at the first failure.
// execute is the command runner of src/execute.js (passed in because execute.js loads this file).
// It returns { name, target, dryRun, steps: [{ command, options, status, report, error? }], failed }. status is
// 'done', 'preview' (a remove-* step that only listed), 'failed', or 'not run'. Each step runs through execute, so the change journal records the whole recipe as one run.
function runRecipe(file, target, { execute, dryRun = false, progress } = {}) {
  const recipe = loadRecipe(file);
  const result = { name: recipe.name ?? null, target, dryRun, steps: recipe.steps.map((step) => ({ ...step, status: 'not run', report: '' })), failed: false };
  for (const [index, step] of result.steps.entries()) {
    const argv = [step.command, ...step.options, ...(dryRun ? ['--dry-run'] : []), '--', target];
    const report = (line) => progress?.(`Step ${index + 1}/${result.steps.length} ${step.command}: ${line}`);
    try {
      const outcome = execute(argv, { progress: report });
      step.report = typeof outcome.report === 'string' ? outcome.report : '';
      if (outcome.failure) {
        step.status = 'failed';
        step.error = outcome.failure.message;
        if (outcome.failure.output) step.report = outcome.failure.output;
      } else {
        step.status = CONFIRMED_COMMANDS.has(step.command) ? 'preview' : 'done';
      }
    } catch (err) {
      if (!(err instanceof FcError)) throw err;
      step.status = 'failed';
      step.error = err.message;
    }
    if (step.status === 'failed') {
      result.failed = true;
      break;
    }
  }
  return result;
}

const indent = (text) => text.split('\n').map((line) => `  ${line}`).join('\n');

function formatRecipe(result) {
  const total = result.steps.length;
  const lines = [`Recipe${result.name ? ` "${result.name}"` : ''}: ${plural(total, 'step')} on ${result.target}${result.dryRun ? ' (dry run: nothing is changed)' : ''}`];
  result.steps.forEach((step, index) => {
    const options = step.options.length > 0 ? ` ${step.options.join(' ')}` : '';
    const note = { done: '', preview: ' (preview only: nothing deleted)', failed: ' (FAILED)', 'not run': ' (not run)' }[step.status];
    lines.push(`Step ${index + 1}/${total}: ${step.command}${options}${note}`);
    if (step.report !== '') lines.push(indent(step.report));
    if (step.status === 'failed' && step.error && !step.report.includes(step.error)) lines.push(indent(`Error: ${step.error}`));
  });
  const done = result.steps.filter((step) => step.status === 'done' || step.status === 'preview').length;
  if (result.failed) lines.push(`Stopped at the first failure: ${done} of ${plural(total, 'step')} finished. The steps after the failed one were not run.`);
  else lines.push(`All ${plural(total, 'step')} finished.`);
  return lines.join('\n');
}

module.exports = { validateRecipe, loadRecipe, runRecipe, formatRecipe, STEP_COMMANDS };
