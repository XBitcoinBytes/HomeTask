/**
 * createBrowserDelivery — default delivery adapter for V1BackupService.
 *
 * Encapsulates all browser-specific delivery APIs (navigator.share,
 * document, URL) so the service core remains free of them.
 *
 * Interface:
 *   canShare(blob, filename): boolean
 *   share(blob, filename):   Promise<void>   — throws AbortError or Error
 *   download(blob, filename): void
 */
function createBrowserDelivery() {
  return {
    /**
     * Returns true only when the browser supports file-based Web Share API
     * for this blob+filename combination. Mirrors the production two-step check:
     *   navigator.canShare (API exists) && navigator.canShare({ files:[file] })
     */
    canShare(blob, filename) {
      if (!navigator.canShare) return false;
      try {
        const file = new File([blob], filename, { type: blob.type });
        return !!navigator.canShare({ files: [file] });
      } catch {
        return false;
      }
    },

    /**
     * Trigger the Web Share sheet with the backup file.
     * Throws AbortError if the user cancels.
     * Throws other Error on failure (caller falls through to download).
     */
    async share(blob, filename) {
      const file = new File([blob], filename, { type: blob.type });
      await navigator.share({ files: [file], title: 'HomeTask Backup' });
    },

    /**
     * Programmatic download via a temporary anchor element.
     * Revokes the object URL immediately after click.
     */
    download(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
  };
}

export { createBrowserDelivery };
