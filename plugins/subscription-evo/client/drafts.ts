import type { Job } from '../shared/model';

/** Retain slash input when Paseo has already cleared the composer and RPC fails. */
export const drafts = new Map<string, string>();
export const commandRequests = new Map<string, { payload: string; id: string }>();
export type Section = 'compose' | 'queue' | 'rules' | 'goal';
type Focus = { section: Section; objective?: string };
const focuses = new Map<string, Focus>();
const listeners = new Set<() => void>();
const queueListeners = new Set<() => void>();
export const watchQueue = (fn: () => void) => {
  queueListeners.add(fn);
  return () => {
    queueListeners.delete(fn);
  };
};
export const queueChanged = () => {
  queueListeners.forEach((fn) => fn());
};
export type EditorDraft = {
  text: string;
  mode: 'idle' | 'at' | 'quota';
  at: string;
  min: string;
  max: string;
  request: { payload: string; id: string } | null;
};
export const editorDrafts = new Map<string, EditorDraft>();
export const editingDrafts = new Map<string, { job: Job; draft: EditorDraft }>();
export function keepEditingDraft(key: string, job: Job, draft: EditorDraft) {
  if (editingDrafts.size >= 50 && !editingDrafts.has(key))
    throw new Error('Too many unsaved edits. Finish another edit first.');
  editingDrafts.set(key, { job, draft });
}
export const settingsTargets = new Map<string, string>();
export function keepEditorDraft(key: string, draft: EditorDraft) {
  if (!draft.text && !draft.request) {
    editorDrafts.delete(key);
    return;
  }
  if (editorDrafts.size >= 50 && !editorDrafts.has(key))
    throw new Error('Too many unsaved drafts. Finish or clear another draft first.');
  editorDrafts.set(key, draft);
}
export const subscribeFocus = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const getFocus = (key: string) => focuses.get(key);
export function focus(key: string, value: Focus) {
  focuses.set(key, value);
  listeners.forEach((fn) => fn());
}
export function clearClientState() {
  drafts.clear();
  commandRequests.clear();
  focuses.clear();
  listeners.clear();
  queueListeners.clear();
  editorDrafts.clear();
  editingDrafts.clear();
  settingsTargets.clear();
}
export const requestId = () =>
  `ui-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
export function retain(key: string, text: string) {
  if (drafts.size >= 50 && !drafts.has(key))
    throw new Error('Too many unsaved drafts. Recover a draft from Evo first.');
  drafts.set(key, text);
}
