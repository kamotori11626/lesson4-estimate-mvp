import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWorkflowTargetDisplayed,
  navigateToWorkflowTarget,
  workflowNavigationMessages
} from '../public/workflow-navigation.js';

class FakeElement {
  constructor(id, tagName = 'DIV') {
    this.id = id;
    this.tagName = tagName;
    this.parentElement = null;
    this.children = [];
    this.hidden = false;
    this.open = false;
    this.textContent = '';
    this.style = { display: 'block', visibility: 'visible' };
    this.scrollCalls = [];
    this.focusCalls = [];
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  hasAttribute(name) {
    return name === 'hidden' && this.hidden;
  }

  contains(candidate) {
    return candidate === this || this.children.some(child => child.contains(candidate));
  }

  scrollIntoView(options) {
    this.scrollCalls.push(options);
  }

  focus(options) {
    this.focusCalls.push(options);
  }
}

function fakeDocument(elements) {
  const byId = new Map(elements.map(element => [element.id, element]));
  return {
    defaultView: { getComputedStyle: element => element.style },
    getElementById: id => byId.get(id) || null
  };
}

function baseFixture({ outputHidden = false } = {}) {
  const navigationMessage = new FakeElement('workflow-navigation-message', 'P');
  navigationMessage.hidden = true;
  const extractionMessage = new FakeElement('ex-message', 'P');
  const extractionTitle = new FakeElement('extraction-title', 'H2');
  const extractionForm = new FakeElement('extraction-form', 'FORM');
  const submit = new FakeElement('ex-submit', 'BUTTON');
  extractionForm.append(submit);
  const output = new FakeElement('ex-output');
  output.hidden = outputHidden;
  const fieldsTitle = new FakeElement('ex-fields-title', 'H3');
  const fields = new FakeElement('ex-fields', 'TBODY');
  output.append(fieldsTitle, fields);
  return {
    document: fakeDocument([navigationMessage, extractionMessage, extractionTitle, extractionForm, submit, output, fieldsTitle, fields]),
    navigationMessage, extractionMessage, extractionTitle, extractionForm, submit, output, fieldsTitle, fields
  };
}

test('表示中の抽出結果では見出しへ移動し、照合箇所を見せる', () => {
  const fixture = baseFixture();
  const result = navigateToWorkflowTarget({ document: fixture.document, targetId: 'ex-fields' });
  assert.equal(result.status, 'moved');
  assert.equal(fixture.fields.scrollCalls.length, 0);
  assert.deepEqual(fixture.fieldsTitle.scrollCalls, [{ behavior: 'smooth', block: 'start' }]);
  assert.equal(fixture.navigationMessage.hidden, true);
});

test('抽出結果がhiddenなら抽出ボタンへ案内するだけで、処理を実行しない', () => {
  const fixture = baseFixture({ outputHidden: true });
  let submitted = 0;
  fixture.extractionForm.requestSubmit = () => { submitted += 1; };
  fixture.submit.click = () => { submitted += 1; };
  const result = navigateToWorkflowTarget({ document: fixture.document, targetId: 'ex-fields' });
  assert.equal(result.status, 'extraction_not_ready');
  assert.equal(submitted, 0);
  assert.deepEqual(fixture.submit.scrollCalls, [{ behavior: 'smooth', block: 'center' }]);
  assert.deepEqual(fixture.submit.focusCalls, [{ preventScroll: true }]);
  assert.equal(fixture.navigationMessage.textContent, workflowNavigationMessages.extractionNotReady);
  assert.equal(fixture.extractionMessage.textContent, workflowNavigationMessages.extractionNotReady);
  assert.equal(fixture.navigationMessage.hidden, false);
});

test('details内の移動先はdetailsを開いてからスクロールする', () => {
  const details = new FakeElement('workflow-log', 'DETAILS');
  const target = new FakeElement('workflow-log-list', 'OL');
  const message = new FakeElement('workflow-navigation-message', 'P');
  details.append(target);
  const document = fakeDocument([details, target, message]);
  const result = navigateToWorkflowTarget({ document, targetId: 'workflow-log-list' });
  assert.equal(result.status, 'moved');
  assert.equal(details.open, true);
  assert.equal(target.scrollCalls.length, 1);
});

test('存在しないIDは利用者へ案内し、例外を出さない', () => {
  const message = new FakeElement('workflow-navigation-message', 'P');
  message.hidden = true;
  const document = fakeDocument([message]);
  assert.doesNotThrow(() => navigateToWorkflowTarget({ document, targetId: 'not-found' }));
  const result = navigateToWorkflowTarget({ document, targetId: 'not-found' });
  assert.equal(result.status, 'missing');
  assert.equal(message.textContent, workflowNavigationMessages.targetNotAvailable);
  assert.equal(message.hidden, false);
});

test('類似検索・承認判定・メール下書き・人間確認の表示中ターゲットへ従来どおり移動する', () => {
  for (const id of ['similar-search-panel', 'ss-entities', 'ss-quotes-panel', 'approval-email-panel', 'ae-draft']) {
    const target = new FakeElement(id);
    const message = new FakeElement('workflow-navigation-message', 'P');
    const document = fakeDocument([target, message]);
    const result = navigateToWorkflowTarget({ document, targetId: id });
    assert.equal(result.status, 'moved', id);
    assert.equal(target.scrollCalls.length, 1, id);
  }
});

test('hidden属性またはCSSで非表示の一般ターゲットへはスクロールしない', () => {
  for (const configure of [
    target => { target.hidden = true; },
    target => { target.style.display = 'none'; }
  ]) {
    const target = new FakeElement('hidden-target');
    const message = new FakeElement('workflow-navigation-message', 'P');
    configure(target);
    const document = fakeDocument([target, message]);
    assert.equal(isWorkflowTargetDisplayed(target, document), false);
    const result = navigateToWorkflowTarget({ document, targetId: target.id });
    assert.equal(result.status, 'hidden');
    assert.equal(target.scrollCalls.length, 0);
    assert.equal(message.textContent, workflowNavigationMessages.targetNotAvailable);
  }
});
