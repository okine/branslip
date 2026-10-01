// 建议：entries-ops.js 里 export 一个纯函数
export function foldIndexRange(entries, selectedIds) {
    const idxMap = new Map(entries.map((e, i) => [e.id, i]));
    const idxs = [...selectedIds].map(id => idxMap.get(id))
      .filter(i => i != null).sort((a, b) => a - b);
    if (idxs.length < 2) return null;
    for (let i = 1; i < idxs.length; i++) {
      if (idxs[i] !== idxs[i - 1] + 1) return null;
    }
    return { from: idxs[0], to: idxs[idxs.length - 1] };
  }