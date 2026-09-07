export function approverText(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return null;
  return `確認先：${roles.join('、')}`;
}
