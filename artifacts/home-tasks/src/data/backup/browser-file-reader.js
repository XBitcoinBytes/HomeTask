/**
 * createBrowserFileReader — default fileReader adapter for V1BackupService.
 *
 * Encapsulates the FileReader API so the service core remains free of it.
 *
 * Interface: { readAsText(fileLike): Promise<string> }
 */
function createBrowserFileReader() {
  return {
    readAsText(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = e => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Could not read this file. Please try again.'));
        reader.readAsText(file);
      });
    },
  };
}

export { createBrowserFileReader };
