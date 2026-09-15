/* ==========================================================================
   js/sde-parser.js
   --------------------------------------------------------------------------
   Reader and miniature evaluator for Sentaurus SDE command text.

   Why an evaluator and not a set of regular expressions
   -----------------------------------------------------
   An SDE script is Scheme. Coordinates are written as symbols that were
   bound earlier, sizes are arithmetic over those symbols, and region names
   are often built with string-append inside a procedure that is then called
   twice - once for the nMOS and once for the pMOS. A regex can see the text
   `(sdegeo:create-cuboid (position xg0 ya1 zha) ...)` but cannot tell you
   where that cuboid actually is, and it cannot expand a procedure call at
   all. So this file evaluates the script instead of scraping it, which is
   what lets one code path read both an .scm file written by this generator
   and SDE text pasted from somewhere else.

   The evaluator implements only the subset SDE scripts actually use:
   define (values and procedures), arithmetic, string-append, and the
   sde/sdegeo/sdedr command families. Anything it does not recognise is
   recorded verbatim rather than treated as an error, so a partial or
   unusual script still yields whatever geometry it does contain.

   Loaded as a classic script and exposes window.SDE, matching the rest of
   the project so the page keeps working from a file:// URL.
   ========================================================================== */

'use strict';

(function () {

  /* ==================================================================
     1. READER  -  text to s-expressions
     ================================================================== */

  /**
   * Split SDE text into tokens, discarding comments.
   *
   * A `;` only starts a comment when it is outside a string literal: a
   * region name or a mesh prefix may legitimately contain one.
   */
  function tokenize(text) {
    const tokens = [];
    const src = String(text);
    let i = 0;
    let line = 1;

    while (i < src.length) {
      const ch = src[i];

      if (ch === '\n') { line++; i++; continue; }
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f') { i++; continue; }

      // comment to end of line
      if (ch === ';') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }

      // block comment  #| ... |#
      if (ch === '#' && src[i + 1] === '|') {
        i += 2;
        while (i < src.length && !(src[i] === '|' && src[i + 1] === '#')) {
          if (src[i] === '\n') line++;
          i++;
        }
        i += 2;
        continue;
      }

      if (ch === '(' || ch === ')') {
        tokens.push({ type: ch === '(' ? 'open' : 'close', line });
        i++;
        continue;
      }

      // quoted string, with backslash escapes
      if (ch === '"') {
        let out = '';
        i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\') {
            const next = src[i + 1];
            out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
            i += 2;
          } else {
            if (src[i] === '\n') line++;
            out += src[i];
            i++;
          }
        }
        i++;                                   // closing quote
        tokens.push({ type: 'string', value: out, line });
        continue;
      }

      // bare atom: symbol or number
      let atom = '';
      while (i < src.length && !' \t\r\n\f()";'.includes(src[i])) {
        atom += src[i];
        i++;
      }
      if (atom === '') { i++; continue; }      // defensive, cannot normally happen

      if (isNumeric(atom)) {
        tokens.push({ type: 'number', value: parseFloat(atom), line });
      } else {
        tokens.push({ type: 'symbol', value: atom, line });
      }
    }

    return tokens;
  }

  /** Scheme numbers, including 1e17 and a leading sign or dot. */
  function isNumeric(s) {
    return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s);
  }

  /**
   * Build nested lists from tokens.
   * Unbalanced parentheses are reported rather than thrown, so a truncated
   * paste still produces the forms that were complete.
   */
  function read(tokens, errors) {
    const forms = [];
    let i = 0;

    function readForm() {
      const tok = tokens[i];
      if (!tok) return undefined;

      if (tok.type === 'open') {
        i++;
        const list = [];
        list.line = tok.line;
        while (i < tokens.length && tokens[i].type !== 'close') {
          const f = readForm();
          if (f === undefined) break;
          list.push(f);
        }
        if (i >= tokens.length) {
          errors.push(`unclosed "(" opened on line ${tok.line}`);
        } else {
          i++;                                 // consume ')'
        }
        return list;
      }

      if (tok.type === 'close') {
        errors.push(`unexpected ")" on line ${tok.line}`);
        i++;
        return undefined;
      }

      i++;
      if (tok.type === 'symbol') return { sym: tok.value, line: tok.line };
      return tok.value;                        // number or string
    }

    while (i < tokens.length) {
      const before = i;
      const f = readForm();
      if (f !== undefined) forms.push(f);
      if (i === before) i++;                   // never spin on a bad token
    }
    return forms;
  }

  const isSym = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) && 'sym' in x;
  const symName = (x) => (isSym(x) ? x.sym : null);


  /* ==================================================================
     2. EVALUATOR
     ================================================================== */

  /** A value the evaluator could not resolve. Kept rather than thrown so an
      unresolved coordinate does not discard the whole command. */
  function Unknown(label) { return { unknown: true, label }; }
  const isUnknown = (v) => v !== null && typeof v === 'object' && v.unknown === true;

  function Position(x, y, z) { return { position: true, x, y, z }; }
  const isPosition = (v) => v !== null && typeof v === 'object' && v.position === true;

  function makeEnv(parent) {
    return { vars: Object.create(null), parent };
  }

  function lookup(env, name) {
    for (let e = env; e; e = e.parent) {
      if (name in e.vars) return e.vars[name];
    }
    return undefined;
  }

  function define(env, name, value) { env.vars[name] = value; }

  const num = (v) => (typeof v === 'number' ? v : NaN);

  /**
   * Evaluate one form.
   * `ctx` collects everything the caller wants out of the script.
   */
  function evaluate(form, env, ctx) {
    // literals
    if (typeof form === 'number' || typeof form === 'string') return form;

    // symbol reference
    if (isSym(form)) {
      const v = lookup(env, form.sym);
      return v === undefined ? Unknown(form.sym) : v;
    }

    if (!Array.isArray(form)) return Unknown('?');
    if (form.length === 0) return Unknown('()');

    const head = symName(form[0]);

    /* ---------------- special forms ---------------- */

    if (head === 'define') {
      const target = form[1];

      // (define (name a b) body...)
      if (Array.isArray(target)) {
        const fname = symName(target[0]);
        const params = target.slice(1).map(symName);
        define(env, fname, { closure: true, params, body: form.slice(2), env });
        return Unknown(fname);
      }

      // (define name expr)
      const vname = symName(target);
      const value = form.length > 2 ? evaluate(form[2], env, ctx) : Unknown(vname);
      define(env, vname, value);
      ctx.defines.push({ name: vname, value });
      return value;
    }

    if (head === 'begin') {
      let last;
      for (let k = 1; k < form.length; k++) last = evaluate(form[k], env, ctx);
      return last;
    }

    if (head === 'let' || head === 'let*') {
      const inner = makeEnv(env);
      const bindings = Array.isArray(form[1]) ? form[1] : [];
      for (const b of bindings) {
        if (Array.isArray(b) && b.length >= 2) {
          define(inner, symName(b[0]), evaluate(b[1], head === 'let*' ? inner : env, ctx));
        }
      }
      let last;
      for (let k = 2; k < form.length; k++) last = evaluate(form[k], inner, ctx);
      return last;
    }

    if (head === 'if') {
      const test = evaluate(form[1], env, ctx);
      const truthy = !(test === false || test === 0 || isUnknown(test));
      return truthy ? evaluate(form[2], env, ctx)
                    : (form.length > 3 ? evaluate(form[3], env, ctx) : Unknown('if'));
    }

    if (head === 'quote') return form[1];

    /* ---------------- application ---------------- */

    const args = [];
    for (let k = 1; k < form.length; k++) args.push(evaluate(form[k], env, ctx));

    // a user-defined procedure: bind parameters and run the body
    const fn = head ? lookup(env, head) : undefined;
    if (fn && fn.closure) {
      if (ctx.depth > 64) {
        ctx.errors.push(`procedure "${head}" nested too deeply; stopped expanding`);
        return Unknown(head);
      }
      const inner = makeEnv(fn.env);
      fn.params.forEach((p, idx) => define(inner, p, args[idx]));
      ctx.depth++;
      let last;
      for (const b of fn.body) last = evaluate(b, inner, ctx);
      ctx.depth--;
      return last;
    }

    return applyBuiltin(head, args, form, ctx);
  }

  /* ---------------- builtins and SDE command capture ---------------- */

  function applyBuiltin(head, args, form, ctx) {
    const line = form.line;

    switch (head) {
      case '+': return args.reduce((a, b) => a + num(b), 0);
      case '-':
        if (args.length === 1) return -num(args[0]);
        return args.slice(1).reduce((a, b) => a - num(b), num(args[0]));
      case '*': return args.reduce((a, b) => a * num(b), 1);
      case '/':
        if (args.length === 1) return 1 / num(args[0]);
        return args.slice(1).reduce((a, b) => a / num(b), num(args[0]));
      case 'min': return Math.min(...args.map(num));
      case 'max': return Math.max(...args.map(num));
      case 'abs': return Math.abs(num(args[0]));
      case 'sqrt': return Math.sqrt(num(args[0]));
      case 'expt': return Math.pow(num(args[0]), num(args[1]));

      case 'string-append':
        return args.map((a) => (typeof a === 'string' ? a : isUnknown(a) ? '' : String(a))).join('');
      case 'number->string':
        return String(args[0]);

      case 'position':
        return Position(num(args[0]), num(args[1]), num(args[2]));

      case 'color:rgb':
        return { rgb: args.map(num) };

      case 'find-face-id':
        return { faceId: true, at: isPosition(args[0]) ? args[0] : null };
    }

    if (!head) return Unknown('?');

    /* ---- geometry ---- */
    if (head === 'sdegeo:create-cuboid') {
      const [p0, p1, material, name] = args;
      if (isPosition(p0) && isPosition(p1)) {
        const region = {
          name: typeof name === 'string' ? name : `region_${ctx.regions.length + 1}`,
          material: typeof material === 'string' ? material : 'Unknown',
          x0: Math.min(p0.x, p1.x), x1: Math.max(p0.x, p1.x),
          y0: Math.min(p0.y, p1.y), y1: Math.max(p0.y, p1.y),
          z0: Math.min(p0.z, p1.z), z1: Math.max(p0.z, p1.z),
          line,
        };
        const bad = ['x0', 'x1', 'y0', 'y1', 'z0', 'z1'].some((k) => Number.isNaN(region[k]));
        if (bad) {
          ctx.errors.push(`cuboid "${region.name}" has a coordinate that could not be resolved`);
        } else {
          ctx.regions.push(region);
        }
      } else {
        ctx.errors.push('create-cuboid without two resolvable positions');
      }
      ctx.commands.push({ op: head, args, line });
      return Unknown(head);
    }

    /* ---- doping ---- */
    if (head === 'sdedr:define-constant-profile') {
      ctx.profiles.push({ name: args[0], field: args[1], value: args[2] });
      ctx.commands.push({ op: head, args, line });
      return Unknown(head);
    }
    if (head === 'sdedr:define-constant-profile-region') {
      ctx.doping.push({ placement: args[0], profile: args[1], region: args[2] });
      ctx.commands.push({ op: head, args, line });
      return Unknown(head);
    }

    /* ---- contacts ---- */
    if (head === 'sdegeo:define-contact-set') {
      ctx.contacts.push({ name: args[0], faces: [] });
      ctx.commands.push({ op: head, args, line });
      return Unknown(head);
    }
    if (head === 'sdegeo:set-contact-faces') {
      const name = typeof args[1] === 'string' ? args[1] : ctx.currentContact;
      const c = ctx.contacts.find((x) => x.name === name);
      const at = args[0] && args[0].faceId ? args[0].at : null;
      if (c) c.faces.push(at);
      else if (name) ctx.contacts.push({ name, faces: [at] });
      ctx.commands.push({ op: head, args, line });
      return Unknown(head);
    }
    if (head === 'sdegeo:set-current-contact-set') {
      ctx.currentContact = args[0];
      ctx.commands.push({ op: head, args, line });
      return Unknown(head);
    }

    /* ---- mesh ---- */
    if (head === 'sdedr:define-refinement-size' ||
        head === 'sdedr:define-refinement-window' ||
        head === 'sdedr:define-refinement-placement' ||
        head === 'sdedr:define-refinement-function') {
      ctx.refinements.push({ op: head, args });
      ctx.commands.push({ op: head, args, line });
      return Unknown(head);
    }

    /* ---- build ---- */
    if (head === 'sde:build-mesh') {
      const prefix = args.filter((a) => typeof a === 'string').pop();
      if (typeof prefix === 'string') ctx.meshPrefix = prefix;
      ctx.commands.push({ op: head, args, line });
      return Unknown(head);
    }

    // anything else: keep it, in order, without judgement
    ctx.commands.push({ op: head, args, line });
    if (/^(sde|sdegeo|sdedr|sdepe):/.test(head)) ctx.knownFamily = true;
    return Unknown(head);
  }


  /* ==================================================================
     3. PUBLIC ENTRY POINT
     ================================================================== */

  /**
   * Parse SDE text.
   *
   * Returns everything the app needs from a script, whatever its shape:
   * the resolved variable bindings, the fully expanded region list, the
   * doping placements, the contacts, the mesh refinements and the mesh
   * prefix. `errors` is advisory - a script can parse usefully while still
   * containing something this evaluator did not follow.
   */
  function parse(text) {
    const errors = [];
    const tokens = tokenize(text);
    const forms = read(tokens, errors);

    const ctx = {
      defines: [], regions: [], profiles: [], doping: [],
      contacts: [], refinements: [], commands: [],
      meshPrefix: null, currentContact: null,
      knownFamily: false, errors, depth: 0,
    };

    const env = makeEnv(null);
    for (const form of forms) {
      try {
        evaluate(form, env, ctx);
      } catch (e) {
        errors.push(`line ${form && form.line ? form.line : '?'}: ${e.message}`);
      }
    }

    // flatten the environment into a plain name -> number/string map
    const bindings = {};
    for (const [k, v] of Object.entries(env.vars)) {
      if (typeof v === 'number' || typeof v === 'string') bindings[k] = v;
    }

    return {
      ok: ctx.regions.length > 0 || ctx.commands.length > 0,
      errors,
      bindings,
      defines: ctx.defines.filter((d) => typeof d.value === 'number' || typeof d.value === 'string'),
      regions: ctx.regions,
      profiles: ctx.profiles,
      doping: ctx.doping,
      contacts: ctx.contacts,
      refinements: ctx.refinements,
      commands: ctx.commands,
      meshPrefix: ctx.meshPrefix,
      looksLikeSde: ctx.knownFamily || ctx.regions.length > 0,
    };
  }

  /**
   * Decide what a piece of input is before doing anything with it.
   * Both an uploaded .scm and pasted text reach this, so detection is by
   * content, never by file extension.
   */
  function detect(text, filename) {
    const t = String(text || '');
    const trimmed = t.trim();
    if (!trimmed) return { kind: 'empty', reason: 'the input is empty' };

    const hasSdeCall = /\((sde|sdegeo|sdedr|sdepe):[a-z-]/i.test(t);
    const hasDefine = /\(\s*define\s/.test(t);
    const hasParens = t.includes('(') && t.includes(')');

    if (!hasParens) {
      return { kind: 'unknown', reason: 'no Scheme expressions found - this does not look like SDE input' };
    }
    if (!hasSdeCall && !hasDefine) {
      return { kind: 'unknown', reason: 'no sde:, sdegeo: or sdedr: commands and no define found' };
    }

    const ext = (String(filename || '').match(/\.([a-z0-9]+)$/i) || [])[1];
    return {
      kind: hasSdeCall ? 'sde' : 'defines-only',
      source: filename ? `file ${filename}` : 'pasted text',
      ext: ext ? ext.toLowerCase() : null,
    };
  }

  /* ==================================================================
     4. RE-EMITTER  -  a parsed script back out as clean SDE
     ==================================================================
     Used for imported text that is not one of this generator's own
     parameter sets. The commands are written back in the order a device is
     built, with every coordinate resolved to a number, so the result is a
     plain step-by-step script with no comments and nothing left to look up.
     ================================================================== */

  /** Format a number the way the rest of the project does. */
  function fmtNum(v) {
    if (!Number.isFinite(v)) return '0.0';
    /* Doping concentrations are written 1e17, 5e19, 1e20. String(1e17) does
       NOT give that - JavaScript only switches to exponential notation at
       1e21, so it would print 100000000000000000 and turn a readable
       concentration into a wall of zeros. toExponential() is explicit. */
    if (v !== 0 && (Math.abs(v) < 1e-4 || Math.abs(v) >= 1e6)) {
      return v.toExponential().replace('e+', 'e');
    }
    let s = Number(v).toFixed(6);
    if (Object.is(v, -0)) s = (0).toFixed(6);
    s = s.replace(/0+$/, '');
    if (s.endsWith('.')) s += '0';
    if (s === '-0.0' || s === '-0.') s = '0.0';
    return s;
  }

  /** One evaluated argument back to Scheme source text. */
  function fmtArg(a) {
    if (typeof a === 'number') return fmtNum(a);
    if (typeof a === 'string') return `"${a.replace(/(["\\])/g, '\\$1')}"`;
    if (isPosition(a)) return `(position ${fmtNum(a.x)} ${fmtNum(a.y)} ${fmtNum(a.z)})`;
    if (a && a.rgb) return `(color:rgb ${a.rgb.map(fmtNum).join(' ')})`;
    if (a && a.faceId) {
      return a.at ? `(find-face-id ${fmtArg(a.at)})` : '(find-face-id)';
    }
    if (isUnknown(a)) return a.label || '()';
    return String(a);
  }

  /** Which step of the build a command belongs to. */
  function stepOf(op) {
    if (op === 'sde:build-mesh') return 6;
    if (/^sdedr:define-refinement/.test(op)) return 5;
    if (/^sdegeo:(define-contact-set|set-current-contact-set|set-contact-faces)$/.test(op)) return 4;
    if (/^sdedr:define-constant-profile/.test(op)) return 3;
    if (/^sdegeo:create-/.test(op)) return 2;
    return 0;                                    // setup: clear, booleans, up-direction
  }

  /**
   * Re-emit a parsed script as clean, ordered, comment-free SDE.
   * Order: setup, parameters, geometry, doping, contacts, mesh, build.
   */
  function format(parsed) {
    const out = [];
    const emit = (lines) => {
      if (!lines.length) return;
      if (out.length) out.push('');
      out.push(...lines);
    };

    const step = (k) => parsed.commands
      .filter((c) => stepOf(c.op) === k)
      .map((c) => `(${c.op}${c.args.length ? ' ' + c.args.map(fmtArg).join(' ') : ''})`);

    emit(step(0));
    emit(parsed.defines.map((d) =>
      `(define ${d.name} ${typeof d.value === 'number' ? fmtNum(d.value) : fmtArg(d.value)})`));
    emit(step(2));
    emit(step(3));
    emit(step(4));
    emit(step(5));
    emit(step(6));

    return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  }

  window.SDE = { parse, detect, format, tokenize, read };

})();
