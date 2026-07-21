(function () {
  // "Show AI process" toggle: flips every per-turn AI disclosure open/closed at
  // once and remembers the choice. The checkbox's server-rendered `checked` state
  // is the default (it mirrors the report's --ai mode); a saved preference wins.
  var box = document.getElementById('st-ai');
  if (!box) return;
  var KEY = 'showtail-show-ai';
  function apply(on) {
    var nodes = document.querySelectorAll('details.ai-process');
    for (var i = 0; i < nodes.length; i++) nodes[i].open = on;
  }
  var saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch (e) {}
  if (saved === '1' || saved === '0') box.checked = saved === '1';
  apply(box.checked);
  box.addEventListener('change', function () {
    try {
      localStorage.setItem(KEY, box.checked ? '1' : '0');
    } catch (e) {}
    apply(box.checked);
  });
})();
