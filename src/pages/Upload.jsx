import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  collection,
  doc,
  writeBatch,
  serverTimestamp
} from 'firebase/firestore';
import { db } from '../../firebase';
import Papa from 'papaparse';
import {
  Upload as UploadIcon,
  FileText,
  CheckCircle,
  AlertCircle,
  X
} from 'lucide-react';
import LoadingSpinner from '../components/LoadingSpinner';

const Upload = () => {
  const [file, setFile] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState([]);
  const [uploadStatus, setUploadStatus] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  // ----- Helpers -----
  // canonicalize header text to stable token and map common synonyms to canonical keys
  const canonicalHeader = (h) => {
    const raw = String(h || '').toLowerCase().trim();
    // replace non-alnum with single underscore and trim underscores
    const cleaned = raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (/enroll|enrol|roll|studentid|id\b/.test(cleaned)) return 'enrollId';
    if (/name|full_name|student_name/.test(cleaned)) return 'name';
    if (/attendance|attendance_pct|attendance_percent|att|attn/.test(cleaned)) return 'attendance';
    if (/score|marks|mark|result/.test(cleaned)) return 'score';
    if (/fee|fee_status|fees/.test(cleaned)) return 'fee';
    return cleaned || h;
  };

  // sanitize doc id (lowercase, alpha-num & underscores only)
  const sanitizeDocId = (raw) =>
    String(raw || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/^_+|_+$/g, '')
      .substring(0, 100) || null;

  // parse a numeric cell flexibly (handles "85%", " 85 ", "1,234", etc.)
  const parseNumber = (v) => {
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    if (s === '') return undefined;
    // strip anything that's not digit, dot, or minus
    const cleaned = s.replace(/[, ]+/g, '').replace(/[^0-9.\-]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  };

  // risk calc (keeps your logic but robustly converts values)
  const calculateRisk = (student) => {
    const issues = [];
    const att = Number(student.attendance) || 0;
    const sc = Number(student.score) || 0;
    const feeLower = String(student.fee || '').toLowerCase();

    if (att < 75) issues.push('Low Attendance');
    if (sc < 40) issues.push('Low Score');
    if (feeLower === 'unpaid' || feeLower === '0') issues.push('Unpaid Fee');

    if (issues.includes('Unpaid Fee') || issues.length > 1) return 'Red';
    if (issues.length === 1) return 'Yellow';
    return 'Green';
  };

  // ----- File selection & parsing -----
  const handleFileSelect = (selectedFile) => {
    if (!selectedFile) return;
    const isCsv = selectedFile.type === 'text/csv' || selectedFile.name?.toLowerCase().endsWith('.csv') || selectedFile.type === '';
    if (!isCsv) {
      setError('Please select a CSV file');
      return;
    }
    setFile(selectedFile);
    setError('');
    parseCSV(selectedFile);
  };

  const parseCSV = (csvFile) => {
    if (!csvFile) {
      setError('No file selected.');
      return;
    }

    Papa.parse(csvFile, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
      transformHeader: canonicalHeader,
      complete: (results) => {
        if (results.errors && results.errors.length > 0) {
          setError('Error parsing CSV: ' + results.errors[0].message);
          return;
        }

        const rows = (results.data || [])
          .filter((r) => Object.values(r).some((v) => v !== null && v !== undefined && String(v).trim() !== ''))
          .map((r, idx) => {
            // Because transformHeader already mapped common header names,
            // we can safely reference r.enrollId / r.name / r.attendance etc.
            const rawEnroll = r.enrollId ?? r.enroll ?? r.enroll_id ?? '';
            const nameCandidate = r.name ?? r.student_name ?? '';
            const attendanceRaw = r.attendance ?? r.attendance_percent ?? r['attendance_%'] ?? undefined;
            const scoreRaw = r.score ?? r.marks ?? r.mark ?? undefined;
            const feeRaw = r.fee ?? r.fee_status ?? '';

            const enrollId = rawEnroll !== undefined ? String(rawEnroll).trim() : '';
            const name = (nameCandidate && String(nameCandidate).trim()) || (enrollId ? `Student-${enrollId}` : `Student-${idx + 1}`);
            const attendance = parseNumber(attendanceRaw);
            const score = parseNumber(scoreRaw);
            const fee = (feeRaw && String(feeRaw).trim()) || 'unpaid';

            const student = {
              enrollId,
              name,
              attendance: attendance !== undefined ? attendance : 0,
              score: score !== undefined ? score : 0,
              fee: fee.toString()
            };

            student.risk = calculateRisk(student);
            return student;
          });

        // dedupe by enrollId (if present) - keep last occurrence from file
        const byId = new Map();
        rows.forEach((s, i) => {
          const key = sanitizeDocId(s.enrollId) || sanitizeDocId(s.name) || `row_${i}`;
          byId.set(key, s);
        });
        const final = Array.from(byId.values());

        setPreview(final);
      },
      error: (err) => {
        setError('Failed to parse CSV: ' + (err?.message || err));
      }
    });
  };

  // ----- Drag handlers -----
  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    if (e.type === 'dragleave') setDragActive(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFileSelect(e.dataTransfer.files[0]);
  };

  // ----- Upload (batch) -----
  const handleUpload = async () => {
    if (!preview.length) {
      setError('Nothing to upload. Please select and preview a CSV.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const batch = writeBatch(db);
      const studentsRef = collection(db, 'students');

      preview.forEach((s, idx) => {
        // Prefer enrollId as docId; fallback to sanitized name+index so it is deterministic
        const candidate = sanitizeDocId(s.enrollId) || sanitizeDocId(`${s.name}_${idx}`) || `r_${Date.now()}_${idx}`;
        const ref = doc(db, 'students', candidate);
        batch.set(ref, {
          enrollId: s.enrollId || '',
          name: s.name || '',
          attendance: Number(s.attendance) || 0,
          score: Number(s.score) || 0,
          fee: s.fee || 'unpaid',
          risk: s.risk || calculateRisk(s),
          updatedAt: serverTimestamp(),
          createdAt: serverTimestamp()
        });
      });

      await batch.commit();
      setUploadStatus('success');

      // navigate back to dashboard after short delay
      setTimeout(() => navigate('/dashboard'), 1100);
    } catch (err) {
      console.error('Upload error:', err);
      setError('Failed to upload data: ' + (err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  const getRiskBadge = (risk) => {
    const colors = {
      Green: 'bg-green-500/20 text-green-400 border-green-500/30',
      Yellow: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
      Red: 'bg-red-500/20 text-red-400 border-red-500/30'
    };
    return <span className={`px-2 py-1 rounded-full text-xs font-semibold border ${colors[risk]}`}>{risk}</span>;
  };

  // ----- UI -----
  if (uploadStatus === 'success') {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
        <div className="text-center animate-scale-in">
          <div className="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle className="w-10 h-10 text-green-400" />
          </div>
          <h2 className="text-3xl font-bold text-white mb-2">Upload Successful!</h2>
          <p className="text-gray-400 mb-6">{preview.length} students uploaded.</p>
          <p className="text-sm text-gray-500">Redirecting to dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 py-8">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">Upload Student Data</h1>
          <p className="text-gray-400">CSV headers are flexible — we auto-map common header names (enroll, name, attendance, score, fee)</p>
        </div>

        <div
          className={`relative border-2 border-dashed rounded-2xl p-8 text-center transition-all duration-300 cursor-pointer ${dragActive ? 'border-primary-500 bg-primary-500/10' : 'border-gray-700 hover:border-primary-500 hover:bg-primary-500/5'}`}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={() => document.getElementById('fileInput')?.click()}
        >
          <input id="fileInput" type="file" accept=".csv" onChange={(e) => handleFileSelect(e.target.files?.[0])} className="hidden" />

          <div className="flex flex-col items-center space-y-4">
            <div className={`w-16 h-16 rounded-xl flex items-center justify-center ${file ? 'bg-green-500/20' : 'bg-gray-800'}`}>
              {file ? <FileText className="w-8 h-8 text-green-400" /> : <UploadIcon className="w-8 h-8 text-gray-400" />}
            </div>

            <div>
              <p className="text-xl font-semibold text-white mb-2">{file ? file.name : 'Drop your CSV file here'}</p>
              <p className="text-gray-400">or click to browse files</p>
            </div>

            {file && (
              <button onClick={(e) => { e.stopPropagation(); setFile(null); setPreview([]); setError(''); }} className="flex items-center space-x-2 px-4 py-2 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-colors">
                <X className="w-4 h-4" />
                <span>Remove file</span>
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 p-4 bg-gray-900/50 border border-gray-800 rounded-xl">
          <h3 className="text-sm font-semibold text-white mb-2">Recommended CSV headers (flexible)</h3>
          <div className="text-xs text-gray-400 font-mono bg-gray-800/50 p-2 rounded">
            enroll,name,attendance,score,fee<br />
            101,John Doe,85,75,paid<br />
            102,Jane Smith,60,35,unpaid
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center space-x-3 mt-4">
            <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
            <p className="text-red-400">{error}</p>
          </div>
        )}

        {preview.length > 0 && (
          <div className="mb-8 mt-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-white">Preview ({preview.length} students)</h2>
              <button onClick={handleUpload} disabled={loading} className="flex items-center space-x-2 px-6 py-3 gradient-primary text-white rounded-xl font-semibold btn-hover disabled:opacity-50 disabled:cursor-not-allowed">
                {loading ? <LoadingSpinner size="small" /> : <UploadIcon className="w-5 h-5" />}
                <span>{loading ? 'Uploading...' : 'Upload to Database'}</span>
              </button>
            </div>

            <div className="bg-gray-900/50 border border-gray-800 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-900">
                    <tr>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Enroll ID</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Name</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Attendance %</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Score</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Fee</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Risk</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {preview.slice(0, 500).map((s, i) => (
                      <tr key={i} className="hover:bg-gray-800/50 transition-colors">
                        <td className="px-6 py-4 text-sm text-gray-300">{s.enrollId || '-'}</td>
                        <td className="px-6 py-4 text-sm font-medium text-white">{s.name}</td>
                        <td className="px-6 py-4 text-sm text-gray-300">{s.attendance}%</td>
                        <td className="px-6 py-4 text-sm text-gray-300">{s.score}</td>
                        <td className="px-6 py-4 text-sm text-gray-300 capitalize">{s.fee}</td>
                        <td className="px-6 py-4 text-sm">{getRiskBadge(s.risk)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.length > 500 && (
                <div className="px-6 py-3 bg-gray-800/50 border-t border-gray-800 text-center">
                  <p className="text-sm text-gray-400">Showing first 500 of {preview.length} students</p>
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
};

export default Upload;
