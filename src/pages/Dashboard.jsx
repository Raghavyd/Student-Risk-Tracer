import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  getDocs,
  deleteDoc,
  doc,
} from "firebase/firestore";
import { db } from "../../firebase";
import {
  Users,
  AlertTriangle,
  TrendingUp,
  Search,
  Trash2,
  RefreshCw,
  Eye,
  BarChart3,
  X,
} from "lucide-react";
import LoadingSpinner from "../components/LoadingSpinner";

/**
 * Dashboard with high-risk alert popup:
 * - Detects newly-seen Red students from Firestore snapshot
 * - Enqueues an alert containing those students
 * - Shows each alert for at least 10 seconds
 * - Uses doc.id as React key (unique)
 */

const ALERT_DISPLAY_MS = 10000; // display duration

const Dashboard = () => {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [riskFilter, setRiskFilter] = useState("All");
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // alert queue & current alert
  const [alertQueue, setAlertQueue] = useState([]); // each item: { id, students: [...] , names: [...] }
  const [currentAlert, setCurrentAlert] = useState(null);
  const alertTimerRef = useRef(null);

  // track which red student doc IDs have been alerted already (session only)
  const alertedRedIdsRef = useRef(new Set());

  // manual fetch fallback (and refresh)
  const fetchStudents = async () => {
    try {
      const col = collection(db, "students");
      const snap = await getDocs(col);
      const arr = snap.docs.map((d) => {
        const data = d.data() || {};
        return {
          id: d.id,
          ...data,
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : data.createdAt,
        };
      });

      // defensive dedupe by doc id
      const map = new Map();
      arr.forEach((s) => map.set(String(s.id), s));
      const deduped = Array.from(map.values());
      setStudents(deduped);
      console.log("Manual fetch -> found ids:", deduped.map((s) => s.id));
    } catch (err) {
      console.error("Error fetching students (fallback):", err);
    } finally {
      setLoading(false);
    }
  };

  // Real-time listener
  useEffect(() => {
    let unsub;
    try {
      const q = query(collection(db, "students")); // don't require createdAt so older docs without it still show
      unsub = onSnapshot(
        q,
        (querySnapshot) => {
          const arr = querySnapshot.docs.map((d) => {
            const data = d.data() || {};
            return {
              id: d.id,
              ...data,
              createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : data.createdAt,
            };
          });

          // defensive dedupe by id
          const map = new Map();
          arr.forEach((s) => map.set(String(s.id), s));
          const deduped = Array.from(map.values());

          // detect newly-seen Red students that were not already alerted this session
          const newRed = deduped.filter(
            (s) => s.risk === "Red" && !alertedRedIdsRef.current.has(String(s.id))
          );

          if (newRed.length > 0) {
            // mark them alerted so we don't repeatedly alert same doc id
            newRed.forEach((s) => alertedRedIdsRef.current.add(String(s.id)));

            // create a single alert payload (lists the new red students)
            const payload = {
              id: `${Date.now()}_${Math.random()}`,
              students: newRed,
              names: newRed.map((s) => s.name || s.studentid || s.id),
            };

            setAlertQueue((prev) => [...prev, payload]);
            console.log("Enqueued Red alert for:", payload.names);
          }

          setStudents(deduped);
          setLoading(false);
        },
        (err) => {
          console.error("Snapshot error:", err);
          setLoading(false);
          fetchStudents();
        }
      );
    } catch (err) {
      console.error("Error setting up snapshot:", err);
      setLoading(false);
      fetchStudents();
    }

    return () => {
      if (unsub) unsub();
    };
  }, []);

  // Start next alert if queue not empty and nothing showing
  useEffect(() => {
    if (!currentAlert && alertQueue.length > 0) {
      startNextAlert();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertQueue, currentAlert]);

  // clean up on unmount
  useEffect(() => {
    return () => {
      if (alertTimerRef.current) {
        clearTimeout(alertTimerRef.current);
        alertTimerRef.current = null;
      }
    };
  }, []);

  function startNextAlert() {
    setAlertQueue((prev) => {
      if (prev.length === 0) return prev;
      const [next, ...rest] = prev;
      setCurrentAlert(next);

      // auto-dismiss after ALERT_DISPLAY_MS
      if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
      alertTimerRef.current = setTimeout(() => {
        dismissCurrentAlert();
      }, ALERT_DISPLAY_MS);

      return rest;
    });
  }

  function dismissCurrentAlert() {
    if (alertTimerRef.current) {
      clearTimeout(alertTimerRef.current);
      alertTimerRef.current = null;
    }
    setCurrentAlert(null);
    // next alert will be started by the useEffect watching alertQueue
  }

  // filteredStudents derived from students
  const filteredStudents = useMemo(() => {
    let list = Array.isArray(students) ? [...students] : [];
    const q = (searchTerm || "").trim().toLowerCase();
    if (q) list = list.filter((s) => (s.name || "").toLowerCase().includes(q));
    if (riskFilter && riskFilter !== "All") list = list.filter((s) => s.risk === riskFilter);
    // sort newest-first if createdAt present
    list.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
    return list;
  }, [students, searchTerm, riskFilter]);

  const stats = useMemo(() => {
    const total = students.length;
    const green = students.filter((s) => s.risk === "Green").length;
    const yellow = students.filter((s) => s.risk === "Yellow").length;
    const red = students.filter((s) => s.risk === "Red").length;
    const averageAttendance =
      total > 0
        ? (students.reduce((sum, s) => sum + (parseFloat(s.attendance) || 0), 0) / total).toFixed(1)
        : 0;
    const averageScore =
      total > 0 ? (students.reduce((sum, s) => sum + (parseFloat(s.score) || 0), 0) / total).toFixed(1) : 0;

    return { total, green, yellow, red, averageAttendance, averageScore };
  }, [students]);

  // Delete student (and optimistic prune)
  const handleDelete = async (studentId) => {
    if (!studentId) {
      console.error("handleDelete called without id:", studentId);
      return;
    }
    if (!window.confirm("Are you sure you want to delete this student?")) return;

    try {
      await deleteDoc(doc(db, "students", studentId));
      // optimistic UI update
      setStudents((prev) => prev.filter((s) => String(s.id) !== String(studentId)));
      if (selectedStudent?.id === studentId) setSelectedStudent(null);
    } catch (err) {
      console.error("Error deleting student:", err);
      alert("Error deleting student: " + (err?.message || err));
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchStudents();
    setRefreshing(false);
  };

  const getRiskStyling = (risk) => {
    switch (risk) {
      case "Green":
        return { bg: "bg-green-500/10 border-l-green-500", badge: "bg-green-500/20 text-green-400 border-green-500/30", icon: "🟢" };
      case "Yellow":
        return { bg: "bg-yellow-500/10 border-l-yellow-500", badge: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30", icon: "🟡" };
      case "Red":
        return { bg: "bg-red-500/10 border-l-red-500", badge: "bg-red-500/20 text-red-400 border-red-500/30", icon: "🔴" };
      default:
        return { bg: "bg-gray-500/10 border-l-gray-500", badge: "bg-gray-500/20 text-gray-400 border-gray-500/30", icon: "⚪" };
    }
  };

  // UI rendering
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <LoadingSpinner size="large" />
          <p className="text-gray-400 mt-4">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-8 animate-fade-in">
          <div>
            <h1 className="text-3xl font-bold text-white mb-2">Student Dashboard</h1>
            <p className="text-gray-400">Monitor student performance and risk levels</p>
          </div>

          <div className="flex items-center space-x-2">
            <div className="flex items-center space-x-2 text-green-400 text-sm">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
              <span>Live Data</span>
            </div>
            <button onClick={handleRefresh} disabled={refreshing} className="flex items-center space-x-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors btn-hover">
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8 animate-slide-up">
          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-6 card-hover">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-400">Total Students</p>
                <p className="text-2xl font-bold text-white">{stats.total}</p>
              </div>
              <div className="w-12 h-12 bg-blue-500/20 rounded-xl flex items-center justify-center">
                <Users className="w-6 h-6 text-blue-400" />
              </div>
            </div>
          </div>

          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-6 card-hover">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-400">High Risk</p>
                <p className="text-2xl font-bold text-red-400">{stats.red}</p>
              </div>
              <div className="w-12 h-12 bg-red-500/20 rounded-xl flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-red-400" />
              </div>
            </div>
          </div>

          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-6 card-hover">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-400">Avg Attendance</p>
                <p className="text-2xl font-bold text-white">{stats.averageAttendance}%</p>
              </div>
              <div className="w-12 h-12 bg-green-500/20 rounded-xl flex items-center justify-center">
                <TrendingUp className="w-6 h-6 text-green-400" />
              </div>
            </div>
          </div>

          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-6 card-hover">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-400">Avg Score</p>
                <p className="text-2xl font-bold text-white">{stats.averageScore}</p>
              </div>
              <div className="w-12 h-12 bg-purple-500/20 rounded-xl flex items-center justify-center">
                <BarChart3 className="w-6 h-6 text-purple-400" />
              </div>
            </div>
          </div>
        </div>

        {/* Search + Filter */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6 animate-slide-up">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-3 w-4 h-4 text-gray-400" />
            <input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="Search students by name..." className="w-full pl-10 pr-4 py-3 bg-gray-900/50 border border-gray-800 rounded-lg text-white" />
          </div>

          <select value={riskFilter} onChange={(e) => setRiskFilter(e.target.value)} className="px-4 py-3 bg-gray-900/50 border border-gray-800 rounded-lg text-white">
            <option value="All">All Risk Levels</option>
            <option value="Green">Low Risk</option>
            <option value="Yellow">Medium Risk</option>
            <option value="Red">High Risk</option>
          </select>
        </div>

        {/* Table */}
        <div className="bg-gray-900/50 border border-gray-800 rounded-xl overflow-hidden animate-slide-up">
          {filteredStudents.length === 0 ? (
            <div className="p-12 text-center">
              <Users className="w-12 h-12 text-gray-600 mx-auto mb-4" />
              <p className="text-gray-400 text-lg">No students found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-900">
                  <tr>
                    <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Student</th>
                    <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Attendance</th>
                    <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Score</th>
                    <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Fee</th>
                    <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Risk</th>
                    <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-gray-800">
                  {filteredStudents.map((student) => {
                    const styling = getRiskStyling(student.risk);
                    return (
                      <tr key={student.id} className={`hover:bg-gray-800/50 transition-all duration-200 border-l-4 ${styling.bg}`}>
                        <td className="px-6 py-4">
                          <div className="flex items-center space-x-3">
                            <div className="w-10 h-10 bg-gradient-to-br from-gray-600 to-gray-700 rounded-full flex items-center justify-center text-white font-semibold">
                              {student.name?.charAt(0)?.toUpperCase() || "N"}
                            </div>
                            <div>
                              <p className="text-sm font-medium text-white">{student.name || "Unknown"}</p>
                              <p className="text-xs text-gray-400">ID: {student.studentid || student.id}</p>
                            </div>
                          </div>
                        </td>

                        <td className="px-6 py-4">
                          <div className="flex items-center space-x-2">
                            <div className={`w-2 h-2 rounded-full ${(parseFloat(student.attendance) || 0) >= 75 ? "bg-green-500" : "bg-red-500"}`}></div>
                            <span className="text-sm text-gray-300">{student.attendance || 0}%</span>
                          </div>
                        </td>

                        <td className="px-6 py-4">
                          <div className="flex items-center space-x-2">
                            <div className={`w-2 h-2 rounded-full ${(parseFloat(student.score) || 0) >= 40 ? "bg-green-500" : "bg-red-500"}`}></div>
                            <span className="text-sm text-gray-300">{student.score || 0}</span>
                          </div>
                        </td>

                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 rounded-full text-xs font-semibold ${student.fee?.toLowerCase() === "paid" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                            {student.fee || "Unknown"}
                          </span>
                        </td>

                        <td className="px-6 py-4">
                          <span className={`px-3 py-1 rounded-full text-xs font-semibold border ${styling.badge}`}>{styling.icon} {student.risk}</span>
                        </td>

                        <td className="px-6 py-4">
                          <div className="flex items-center space-x-2">
                            <button onClick={() => setSelectedStudent(student)} className="p-2 text-gray-400 hover:text-primary-400 hover:bg-primary-500/10 rounded-lg">
                              <Eye className="w-4 h-4" />
                            </button>

                            <button onClick={() => handleDelete(student.id)} className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Student modal (unchanged, uses selectedStudent) */}
        {selectedStudent && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 animate-fade-in">
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-md animate-scale-in">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-bold text-white">Student Details</h3>
                <button onClick={() => setSelectedStudent(null)} className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-4">
                <div className="flex items-center space-x-4">
                  <div className="w-16 h-16 bg-gradient-to-br from-gray-600 to-gray-700 rounded-full flex items-center justify-center text-white font-bold text-xl">
                    {selectedStudent.name?.charAt(0)?.toUpperCase() || "N"}
                  </div>
                  <div>
                    <h4 className="text-lg font-semibold text-white">{selectedStudent.name || "Unknown"}</h4>
                    <p className="text-gray-400">Student ID: {selectedStudent.studentid || selectedStudent.id}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-gray-800/50 p-4 rounded-lg">
                    <p className="text-gray-400 text-sm">Attendance</p>
                    <p className="text-2xl font-bold text-white">{selectedStudent.attendance || 0}%</p>
                  </div>
                  <div className="bg-gray-800/50 p-4 rounded-lg">
                    <p className="text-gray-400 text-sm">Score</p>
                    <p className="text-2xl font-bold text-white">{selectedStudent.score || 0}</p>
                  </div>
                </div>

                <div className="bg-gray-800/50 p-4 rounded-lg">
                  <p className="text-gray-400 text-sm mb-2">Fee Status</p>
                  <span className={`px-3 py-1 rounded-full text-sm font-semibold ${selectedStudent.fee?.toLowerCase() === "paid" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                    {selectedStudent.fee || "Unknown"}
                  </span>
                </div>

                <div className="bg-gray-800/50 p-4 rounded-lg">
                  <p className="text-gray-400 text-sm mb-2">Risk Level</p>
                  <span className={`px-3 py-1 rounded-full text-sm font-semibold border ${getRiskStyling(selectedStudent.risk).badge}`}>
                    {getRiskStyling(selectedStudent.risk).icon} {selectedStudent.risk}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Alert popup (for new Red students) */}
        {currentAlert && (
          <div
            role="alert"
            aria-live="assertive"
            className="fixed bottom-6 right-6 z-50 w-96 bg-red-900/95 border border-red-700 rounded-xl p-4 shadow-lg text-white"
          >
            <div className="flex items-start justify-between">
              <div className="pr-3">
                <h3 className="text-lg font-bold">🚨 High Risk Student{currentAlert.students.length > 1 ? "s" : ""}</h3>
                <p className="text-sm text-red-200 mt-1">
                  {currentAlert.students.length > 1
                    ? `${currentAlert.students.length} students need immediate attention`
                    : `${currentAlert.students[0].name || currentAlert.students[0].studentid || currentAlert.students[0].id} requires attention`}
                </p>
              </div>

              {/* no manual close during the mandatory display period (keeps popup visible for at least 10s) */}
            </div>

            <ul className="mt-3 text-sm space-y-1 max-h-40 overflow-auto">
              {currentAlert.students.map((s) => (
                <li key={s.id} className="flex justify-between items-center">
                  <div>
                    <div className="font-medium">{s.name || s.studentid || s.id}</div>
                    <div className="text-xs text-red-200">
                      Attendance: {s.attendance ?? "0"}% • Score: {s.score ?? "0"}
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <div className="mt-3 text-xs text-red-200">This alert will close automatically in {ALERT_DISPLAY_MS / 1000} seconds.</div>
          </div>
        )}

      </div>
    </div>
  );
};

export default Dashboard;
