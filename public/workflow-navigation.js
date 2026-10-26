const EXTRACTION_NOT_READY_MESSAGE = '抽出結果がまだ表示されていません。入力内容と抽出方法を確認し、「抽出する」を押してください。';
const TARGET_NOT_AVAILABLE_MESSAGE = '移動先を表示できません。画面を再読み込みして、もう一度お試しください。';

function ancestors(node) {
  const result = [];
  for (let current = node; current; current = current.parentElement) result.push(current);
  return result;
}

function isDetails(node) {
  return String(node?.tagName || '').toUpperCase() === 'DETAILS';
}

function openContainingDetails(node) {
  const details = ancestors(node).filter(isDetails).reverse();
  for (const item of details) item.open = true;
}

function hiddenByMarkup(node) {
  return ancestors(node).some(item => item.hidden === true || item.hasAttribute?.('hidden'));
}

function hiddenByStyle(node, document) {
  const view = document.defaultView;
  if (!view?.getComputedStyle) return false;
  return ancestors(node).some(item => {
    const style = view.getComputedStyle(item);
    return style.display === 'none' || style.visibility === 'hidden';
  });
}

export function isWorkflowTargetDisplayed(node, document) {
  return Boolean(node) && !hiddenByMarkup(node) && !hiddenByStyle(node, document);
}

function isInside(node, container) {
  if (!node || !container) return false;
  if (node === container) return true;
  if (typeof container.contains === 'function') return container.contains(node);
  return ancestors(node).includes(container);
}

function showMessage(document, text, extractionMessage = false) {
  const status = document.getElementById('workflow-navigation-message');
  if (status) {
    status.textContent = text;
    status.hidden = false;
  }
  if (extractionMessage) {
    const extractionStatus = document.getElementById('ex-message');
    if (extractionStatus) extractionStatus.textContent = text;
  }
}

function clearMessage(document) {
  const status = document.getElementById('workflow-navigation-message');
  if (!status) return;
  status.textContent = '';
  status.hidden = true;
}

function scrollTo(node, block = 'start') {
  node.scrollIntoView({ behavior: 'smooth', block });
}

/**
 * 「該当箇所へ移動」専用の画面内ナビゲーション。
 * フォーム送信やクリックの代行は行わず、外部通信も行わない。
 */
export function navigateToWorkflowTarget({ document, targetId }) {
  const target = document.getElementById(targetId);
  if (!target) {
    showMessage(document, TARGET_NOT_AVAILABLE_MESSAGE);
    return { status: 'missing', message: TARGET_NOT_AVAILABLE_MESSAGE };
  }

  const extractionOutput = document.getElementById('ex-output');
  if (isInside(target, extractionOutput) && !isWorkflowTargetDisplayed(extractionOutput, document)) {
    const extractionAction = document.getElementById('ex-submit')
      || document.getElementById('extraction-form')
      || document.getElementById('extraction-title');
    showMessage(document, EXTRACTION_NOT_READY_MESSAGE, true);
    if (extractionAction && isWorkflowTargetDisplayed(extractionAction, document)) {
      scrollTo(extractionAction, 'center');
      extractionAction.focus?.({ preventScroll: true });
    }
    return { status: 'extraction_not_ready', message: EXTRACTION_NOT_READY_MESSAGE };
  }

  openContainingDetails(target);
  if (!isWorkflowTargetDisplayed(target, document)) {
    showMessage(document, TARGET_NOT_AVAILABLE_MESSAGE);
    return { status: 'hidden', message: TARGET_NOT_AVAILABLE_MESSAGE };
  }

  clearMessage(document);
  const visibleTarget = targetId === 'ex-fields'
    ? document.getElementById('ex-fields-title') || target
    : target;
  scrollTo(visibleTarget);
  return { status: 'moved', target: visibleTarget };
}

export const workflowNavigationMessages = {
  extractionNotReady: EXTRACTION_NOT_READY_MESSAGE,
  targetNotAvailable: TARGET_NOT_AVAILABLE_MESSAGE
};
