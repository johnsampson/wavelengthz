import { api } from './app.js';
import { requireAuth } from './auth.js';
import { showErrorToast } from './toast.js';
import { navigate } from './router.js';

// Extracted from groups.html's inline script -- see matches.js's comment
// for why (same reasoning, same shape).
export function createGroupsApp() {
  return {
    groups: [],
    error: null,
    showCreate: false,
    newName: '',
    newTopic: '',

    async init() {
      if (!(await requireAuth())) return;
      await this.load();
    },

    async load() {
      this.error = null;
      try {
        const res = await api.groups();
        this.groups = res.groups;
      } catch (e) {
        this.error = 'Could not load groups. Please try again.';
      }
    },

    async create() {
      if (!this.newName.trim()) return;
      this.error = null;
      try {
        await api.createGroup(this.newName.trim(), this.newTopic.trim() || null);
        this.newName = '';
        this.newTopic = '';
        this.showCreate = false;
        await this.load();
      } catch (e) {
        showErrorToast('Could not create that group. Please try again.');
      }
    },

    async join(g) {
      this.error = null;
      try {
        await api.joinGroup(g.id);
        await navigate(`/group?id=${g.id}`);
      } catch (e) {
        if (e.status === 403 && e.body?.error === 'group_full') {
          showErrorToast('That group is full.');
        } else if (e.status === 403 && e.body?.error === 'blocked') {
          showErrorToast('Could not join that group.');
        } else {
          showErrorToast('Could not join that group. Please try again.');
        }
      }
    },
  };
}
