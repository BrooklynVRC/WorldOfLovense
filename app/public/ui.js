// Generic settings form renderer: builds inputs for every field in the config object.
// Hints (from the server) add labels, help text, dropdown options, etc. Keys are dotted
// paths; "*" matches any single segment and "[]" stands for an array item.
(function () {
  function humanize(k) {
    return String(k).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  }
  function matches(pattern, path) {
    const a = pattern.split('.'), b = path.split('.');
    if (a.length !== b.length) return false;
    return a.every((seg, i) => seg === '*' || seg === b[i]);
  }
  function hintFor(hints, path) {
    if (hints[path]) return hints[path];
    let best = null, bestStars = 99;
    for (const k of Object.keys(hints)) {
      if (k.includes('*') && matches(k, path)) {
        const stars = k.split('*').length;
        if (stars < bestStars) { best = hints[k]; bestStars = stars; }
      }
    }
    return best || {};
  }
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null) e.setAttribute(k, v);
    }
    kids.flat().forEach((c) => c != null && e.append(c.nodeType ? c : document.createTextNode(c)));
    return e;
  }
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function render(container, cfg, hints, onChange) {
    container.innerHTML = '';
    const again = () => render(container, cfg, hints, onChange);
    const normal = {}, advanced = {};
    for (const k of Object.keys(cfg)) ((hints[k] || {}).advanced ? advanced : normal)[k] = cfg[k];
    walk(container, normal, '', hints, onChange, again, 0, cfg);
    if (Object.keys(advanced).length) {
      const box = el('details', { class: 'group' }, el('summary', {}, 'Advanced (you can ignore this)'));
      walk(box, advanced, '', hints, onChange, again, 1, cfg);
      container.append(box);
    }
  }

  function walk(parent, obj, path, hints, onChange, rerender, depth, root) {
    if (root) obj = new Proxy(obj, { get: (o, k) => root[k], set: (o, k, v) => { root[k] = v; return true; } });
    for (const key of Object.keys(obj)) {
      const p = path ? path + '.' + key : key;
      const h = hintFor(hints, p);
      if (h.hidden) continue;
      const val = obj[key];
      const label = h.label || humanize(key);
      if (Array.isArray(val)) {
        const box = el('details', { class: 'group', open: depth < 1 ? '' : undefined }, el('summary', {}, label + ` (${val.length})`));
        if (h.help) box.append(el('p', { class: 'help' }, h.help));
        val.forEach((item, i) => {
          const row = el('div', { class: 'array-item' });
          if (item && typeof item === 'object') walk(row, item, p + '.[]', hints, onChange, rerender, depth + 1);
          else row.append(input(val, i, p + '.[]', hintFor(hints, p + '.[]'), onChange));
          row.append(el('button', { class: 'danger small', type: 'button', onclick: () => { val.splice(i, 1); onChange(); rerender(); } }, 'Remove'));
          box.append(row);
        });
        box.append(el('button', { type: 'button', class: 'small', onclick: () => { val.push(clone(h.template !== undefined ? h.template : (val[0] !== undefined ? val[0] : ''))); onChange(); rerender(); } }, '+ Add'));
        parent.append(box);
      } else if (val && typeof val === 'object') {
        const box = el('details', { class: 'group', open: depth < 1 && !h.closed ? '' : undefined }, el('summary', {}, label));
        if (h.help) box.append(el('p', { class: 'help' }, h.help));
        walk(box, val, p, hints, onChange, rerender, depth + 1);
        parent.append(box);
      } else {
        const row = el('label', { class: 'field' }, el('span', { class: 'name' }, label), input(obj, key, p, h, onChange));
        if (h.help) row.append(el('small', { class: 'help' }, h.help));
        parent.append(row);
      }
    }
  }

  function input(obj, key, path, h, onChange) {
    const val = obj[key];
    if (typeof val === 'boolean') {
      return el('input', { type: 'checkbox', ...(val ? { checked: '' } : {}), onchange: (e) => { obj[key] = e.target.checked; onChange(); } });
    }
    if (h.options) {
      const s = el('select', { onchange: (e) => { obj[key] = typeof val === 'number' ? Number(e.target.value) : e.target.value; onChange(); } },
        h.options.map((o) => { const v = typeof o === 'object' ? o.value : o; const t = typeof o === 'object' ? o.label : o; return el('option', { value: v, ...(v == val ? { selected: '' } : {}) }, String(t)); }));
      return s;
    }
    if (typeof val === 'number') {
      return el('input', { type: h.range ? 'range' : 'number', value: val, min: h.min, max: h.max, step: h.step || 'any', oninput: (e) => { obj[key] = Number(e.target.value); if (e.target.nextSibling && e.target.nextSibling.className === 'rv') e.target.nextSibling.textContent = e.target.value; onChange(); } });
    }
    if (h.multiline) {
      const t = el('textarea', { rows: 2, oninput: (e) => { obj[key] = e.target.value; onChange(); } }); t.value = val; return t;
    }
    if (h.color) {
      return el('input', { type: 'text', value: val, class: 'color', oninput: (e) => { obj[key] = e.target.value; e.target.style.borderLeftColor = e.target.value; onChange(); }, style: `border-left: 18px solid ${val}` });
    }
    return el('input', { type: h.secret ? 'password' : 'text', value: val, placeholder: h.placeholder, oninput: (e) => { obj[key] = e.target.value; onChange(); } });
  }

  window.SettingsUI = { render, el };
})();
