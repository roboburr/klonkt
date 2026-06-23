/**
 * PermissionsService — Inline permission checks
 * Used in templates to show/hide edit buttons, delete buttons, etc.
 */

import db from '../config/database.js';

class PermissionsService {
  /**
   * Check if user can edit a post
   */
  static canEditPost(user, post, site) {
    if (!user) return false;
    if (user.role === 'god') return true; // Gods can edit anything
    if (user.id === post.author_id) return true; // Authors can edit their own
    if (this.canAdminSite(user, site)) return true; // Site admins can edit
    return false;
  }

  /**
   * Check if user can delete a post
   */
  static canDeletePost(user, post, site) {
    if (!user) return false;
    if (user.role === 'god') return true;
    if (user.id === post.author_id) return true;
    if (this.canAdminSite(user, site)) return true;
    return false;
  }

  /**
   * Check if user can publish a post
   */
  static canPublishPost(user, post, site) {
    if (!user) return false;
    if (user.role === 'god') return true;
    if (user.id === post.author_id) return true;
    if (this.canAdminSite(user, site)) return true;
    return false;
  }

  /**
   * Check if user can create a post on this site
   */
  static canCreatePost(user, site) {
    if (!user) return false;
    if (user.role === 'god') return true;
    if (!site) return false; // no site context (e.g. hub landing) -> nothing to post to
    if (user.id === site.owner_id) return true; // Site owner
    if (this.canAdminSite(user, site)) return true;
    return false;
  }

  /**
   * Check if user can admin a site
   */
  static canAdminSite(user, site) {
    if (!user || !site) return false;
    if (user.role === 'god') return true;
    if (user.id === site.owner_id) return true;
    // Assigned co-admin (collaborator) via site_members. Previously read from
    // a never-populated user.siteRoles → dead code; now queried directly on
    // the table (a few checks per page, indexed = cheap).
    return !!db.prepare(
      "SELECT 1 FROM site_members WHERE site_id = ? AND user_id = ? AND role = 'admin' LIMIT 1"
    ).get(site.id, user.id);
  }

  /**
   * Check if user can comment on a post
   */
  static canComment(user, site, post) {
    if (!user && site.require_login_to_comment) return false;
    if (!user) return true; // Anonymous allowed if not required
    return true; // Logged-in users can always comment
  }

  /**
   * Check if user can delete a comment
   */
  static canDeleteComment(user, comment, site) {
    if (!user) return false;
    if (user.role === 'god') return true;
    if (user.id === comment.author_id) return true;
    if (this.canAdminSite(user, site)) return true;
    return false;
  }

  /**
   * Check if user can send DMs
   */
  static canSendDM(user) {
    return user !== null; // Only logged-in users
  }

  /**
   * Check if user can configure site settings
   */
  static canConfigureSite(user, site) {
    if (!user) return false;
    if (user.role === 'god') return true;
    if (user.id === site.owner_id) return true;
    return false;
  }

  /**
   * Check if user can manage users for a site
   */
  static canManageUsers(user, site) {
    if (!user) return false;
    if (user.role === 'god') return true;
    if (user.id === site.owner_id) return true;
    return false;
  }
}

export default PermissionsService;
