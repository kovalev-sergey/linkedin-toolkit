/**
 * Queue tab — the Copilot approval queue.
 *
 * Nothing an agent originates leaves the browser until it is approved here.
 * Edits made in the textarea travel with the approval as
 * `queue.approve { ids, edits }`.
 */

import { ACTIONS, EVENTS } from '../../lib/actions.js';
import { call, onEvent } from '../../ui/api.js';
import {
  busyButton,
  card,
  empty,
  errorLine,
  pill,
  row,
  select,
  statusLine,
  textarea,
} from '../../ui/components.js';
import { el, fmtAgo, fmtNumber, render } from '../../ui/dom.js';

export const id = 'queue';
export const label = 'Queue';

const STATUSES = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'sent', label: 'Sent' },
  { value: 'rejected', label: 'Rejected' },
];

const ACTION_LABEL = {
  [ACTIONS.OUTREACH_INVITE]: 'Invite',
  [ACTIONS.OUTREACH_MESSAGE]: 'Message',
  [ACTIONS.OUTREACH_INMAIL]: 'InMail',
  [ACTIONS.OUTREACH_COMMENT]: 'Comment',
};

/** Which contract param an item's editable text lives in. */
export function editableKey(action) {
  return action === ACTIONS.OUTREACH_INVITE ? 'note' : 'body';
}

const statusTone = (status) =>
  status === 'sent' ? 'good' : status === 'rejected' ? 'bad' : 'warn';

export async function mount(container) {
  const err = errorLine();
  const status = statusLine();
  const state = { items: [], filter: 'pending', edits: new Map(), processing: new Map() };

  async function load() {
    const data = await call(ACTIONS.QUEUE_LIST, { status: state.filter });
    state.items = data.items || [];
    if (state.filter === 'pending' && state.processing.size) {
      const approved = await call(ACTIONS.QUEUE_LIST, { status: 'approved' });
      const approvedIds = new Set((approved.items || []).map((item) => item.id));
      for (const [id, item] of state.processing) {
        if (approvedIds.has(id)) state.items.push(item);
        else state.processing.delete(id);
      }
    }
    state.edits = new Map();
  }

  onEvent((name, payload) => {
    if (name !== EVENTS.QUEUE_ITEM_BLOCKED && name !== EVENTS.QUEUE_ITEM_SENT) return;
    if (payload && payload.id) state.processing.delete(payload.id);
    load()
      .then(draw)
      .catch((e) => err.show(e));
  });

  /** Only send an `edits` entry for items the human actually changed. */
  function editsFor(ids) {
    const edits = {};
    for (const itemId of ids) {
      const change = state.edits.get(itemId);
      if (change) edits[itemId] = change;
    }
    return Object.keys(edits).length ? edits : undefined;
  }

  async function approve(ids) {
    if (!ids.length) throw new Error('Nothing to approve.');
    const params = { ids };
    const edits = editsFor(ids);
    if (edits) params.edits = edits;
    const approvedItems = state.items
      .filter((item) => ids.includes(item.id))
      .map((item) => ({ ...item, status: 'approved' }));
    const res = await call(ACTIONS.QUEUE_APPROVE, params);
    if (res.approved) {
      for (const item of approvedItems) state.processing.set(item.id, item);
    }
    status.set(`Approved ${fmtNumber(res.approved)}.`);
    await load();
    draw();
  }

  async function reject(ids) {
    const res = await call(ACTIONS.QUEUE_REJECT, { ids });
    status.set(`Rejected ${fmtNumber(res.rejected)}.`);
    await load();
    draw();
  }

  function itemNode(item) {
    const key = editableKey(item.action);
    const profile = item.profile || {};
    const editable = item.status === 'pending';
    const area = textarea({
      rows: 3,
      value: item.params ? item.params[key] || '' : '',
      disabled: !editable,
      'aria-label': `${ACTION_LABEL[item.action] || item.action} text for ${
        profile.fullName || (item.params && item.params.publicId) || 'this person'
      }`,
      'data-item': item.id,
      oninput: () => {
        state.edits.set(item.id, { [key]: area.value });
      },
    });

    return el(
      'div',
      { class: 'item', 'data-queue': item.id },
      el(
        'div',
        { class: 'item-head' },
        el(
          'span',
          { class: 'item-title' },
          profile.fullName || (item.params && item.params.publicId) || 'Unknown',
        ),
        el(
          'div',
          { class: 'badges' },
          pill(ACTION_LABEL[item.action] || item.action, 'info'),
          pill(item.origin || 'popup'),
          pill(item.status, statusTone(item.status)),
        ),
      ),
      el(
        'div',
        { class: 'item-sub' },
        [profile.title, profile.company].filter(Boolean).join(' · ') || profile.headline || '',
      ),
      item.params && item.params.subject
        ? el('div', { class: 'item-sub mono' }, `Subject: ${item.params.subject}`)
        : null,
      item.params && item.params.attachment
        ? el(
          'div',
          { class: 'item-sub' },
          `Attachment: ${item.params.attachment.name || 'document'}`,
        )
        : null,
      item.result && item.result.error
        ? el(
          'p',
          { class: 'err' },
          `Not sent: ${item.result.error.code ? `${item.result.error.code}: ` : ''}${item.result.error.message || 'The queued action could not be sent.'
          }`,
        )
        : null,
      area,
      el('div', { class: 'item-sub' }, `Queued ${fmtAgo(item.createdAt)}`),
      editable
        ? el(
            'div',
            { class: 'item-actions' },
            busyButton('Approve', () => approve([item.id]), { variant: 'primary', error: err }),
            busyButton('Reject', () => reject([item.id]), { variant: 'ghost', error: err }),
          )
        : null,
    );
  }

  function draw() {
    const filterSelect = select(STATUSES, {
      value: state.filter,
      'aria-label': 'Filter the queue by status',
    });
    filterSelect.addEventListener('change', async () => {
      state.filter = filterSelect.value;
      try {
        await load();
      } catch (e) {
        err.show(e);
      }
      draw();
    });

    const pendingIds = state.items.filter((i) => i.status === 'pending').map((i) => i.id);

    render(container, [
      err,
      status,
      card(
        'Approval queue',
        {
          hint: 'Copilot mode holds every agent-originated write here until you say so.',
          actions: busyButton(
            'Refresh',
            async () => {
              await load();
              draw();
            },
            { variant: 'ghost', error: err },
          ),
        },
        row(
          filterSelect,
          pendingIds.length
            ? busyButton(`Approve all (${pendingIds.length})`, () => approve(pendingIds), {
                variant: 'primary',
                error: err,
              })
            : null,
        ),
        state.items.length
          ? el(
              'div',
              { class: 'itemlist' },
              state.items.map((item) => itemNode(item)),
            )
          : empty(`Nothing ${state.filter}.`),
      ),
    ]);
  }

  try {
    await load();
  } catch (e) {
    err.show(e);
  }
  draw();
}
