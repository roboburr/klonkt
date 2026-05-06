import * as Y from 'yjs';

// Global CRDT document cache
// Key: "siteId:postId"
// Value: { ydoc, lastSaved, updateCallbacks }
const documents = new Map();

export class CRDTService {
  /**
   * Get or create a Yjs document for a post
   */
  static getDocument(siteId, postId, initialBinary = null) {
    const key = `${siteId}:${postId}`;
    
    if (documents.has(key)) {
      return documents.get(key).ydoc;
    }

    // Create new document
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    const ymeta = ydoc.getMap('metadata');

    // If we have stored binary, restore it
    if (initialBinary && initialBinary.length > 0) {
      try {
        Y.applyUpdate(ydoc, initialBinary);
      } catch (err) {
        console.error(`⚠️  Failed to restore CRDT for ${key}:`, err);
      }
    }

    documents.set(key, {
      ydoc,
      lastSaved: Date.now(),
      updateCallbacks: []
    });

    return ydoc;
  }

  /**
   * Get plain text content from document (for FTS5 + display)
   */
  static getPlainText(siteId, postId) {
    const ydoc = this.getDocument(siteId, postId);
    const ytext = ydoc.getText('content');
    return ytext.toString();
  }

  /**
   * Apply an update to a document
   */
  static applyUpdate(siteId, postId, updateBinary) {
    const key = `${siteId}:${postId}`;
    const ydoc = this.getDocument(siteId, postId);
    
    try {
      Y.applyUpdate(ydoc, updateBinary);
      if (documents.has(key)) {
        documents.get(key).lastSaved = Date.now();
      }
      return true;
    } catch (err) {
      console.error(`⚠️  Failed to apply update for ${key}:`, err);
      return false;
    }
  }

  /**
   * Get full state as binary (for persistence to SQLite)
   */
  static encodeState(siteId, postId) {
    const ydoc = this.getDocument(siteId, postId);
    return Y.encodeStateAsUpdate(ydoc);
  }

  /**
   * Register a callback for document updates
   */
  static onUpdate(siteId, postId, callback) {
    const key = `${siteId}:${postId}`;
    const ydoc = this.getDocument(siteId, postId);

    // Store callback for later cleanup
    if (!documents.has(key)) {
      documents.set(key, { ydoc, lastSaved: Date.now(), updateCallbacks: [] });
    }
    documents.get(key).updateCallbacks.push(callback);

    // Trigger callback on every update
    const listener = (update, origin) => {
      if (origin !== 'local') {
        callback(update);
      }
    };

    ydoc.on('update', listener);

    // Return unsubscribe function
    return () => {
      ydoc.off('update', listener);
    };
  }

  /**
   * Clean up old documents from memory
   */
  static cleanup(olderThanMinutes = 60) {
    const cutoff = Date.now() - (olderThanMinutes * 60 * 1000);
    let cleaned = 0;

    for (const [key, value] of documents.entries()) {
      if (value.lastSaved < cutoff) {
        value.ydoc.destroy();
        documents.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`🧹 CRDT: Cleaned ${cleaned} old documents`);
    }
  }

  /**
   * Destroy a document
   */
  static destroy(siteId, postId) {
    const key = `${siteId}:${postId}`;
    if (documents.has(key)) {
      documents.get(key).ydoc.destroy();
      documents.delete(key);
    }
  }

  /**
   * Get stats (for debugging)
   */
  static getStats() {
    return {
      documentsInMemory: documents.size,
      documents: Array.from(documents.keys())
    };
  }
}

export default CRDTService;
