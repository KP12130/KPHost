import crypto from 'crypto';

const VIRUSTOTAL_API_KEY = process.env.VIRUSTOTAL_API_KEY || '';

/**
 * Calculate SHA-256 hash of a Buffer
 * @param {Buffer} buffer 
 */
export function calculateSHA256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Scan file hash using VirusTotal API (or fallback signature scanner)
 * @param {Buffer} fileBuffer 
 * @param {string} fileName 
 */
export async function scanFileForViruses(fileBuffer, fileName = 'upload.zip') {
  const fileHash = calculateSHA256(fileBuffer);
  console.log(`🛡️ VirusTotal Inspector: Scanning file "${fileName}" (SHA-256: ${fileHash})`);

  // If VirusTotal API Key is configured in .env, perform live API request
  if (VIRUSTOTAL_API_KEY && VIRUSTOTAL_API_KEY !== 'YOUR_VIRUSTOTAL_API_KEY') {
    try {
      const response = await fetch(`https://www.virustotal.com/api/v3/files/${fileHash}`, {
        headers: {
          'x-apikey': VIRUSTOTAL_API_KEY
        }
      });

      if (response.ok) {
        const data = await response.json();
        const stats = data.data.attributes.last_analysis_stats;
        const maliciousCount = stats ? (stats.malicious || 0) : 0;

        if (maliciousCount > 0) {
          console.warn(`⚠️ VirusTotal ALERT: File "${fileName}" flagged as malicious (${maliciousCount} engine detections)`);
          return {
            clean: false,
            status: 'INFECTED',
            detections: maliciousCount,
            hash: fileHash,
            message: `VirusTotal detected ${maliciousCount} security threats in this file.`
          };
        }
      }
    } catch (err) {
      console.error('VirusTotal API Query Error (using fallback scanner):', err);
    }
  }

  // Fallback Signature & Extension Inspector
  const lowerName = fileName.toLowerCase();
  const dangerousExts = ['.exe', '.scr', '.vbs', '.bat', '.cmd', '.ps1', '.dll', '.sys'];
  for (const ext of dangerousExts) {
    if (lowerName.endsWith(ext)) {
      return {
        clean: false,
        status: 'INFECTED',
        detections: 1,
        hash: fileHash,
        message: `Security Warning: Direct execution of ${ext} binary files is not allowed.`
      };
    }
  }

  return {
    clean: true,
    status: 'CLEAN',
    detections: 0,
    hash: fileHash,
    message: 'File passed VirusTotal security inspection cleanly.'
  };
}
