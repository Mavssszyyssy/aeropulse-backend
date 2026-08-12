const Attendance = require("../models/Attendance");
const User = require("../models/User");

const dayKey = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const toView = (attendance, user) => {
  const json = attendance.toJSON();
  return {
    ...json,
    userName: user?.name || "",
    userEmail: user?.email || "",
  };
};

const isAdminRole = (role) => role === "admin" || role === "superadmin";

const getScopedAttendanceQuery = (req) => {
  const query = {};
  if (req.authUser.role !== "superadmin") {
    query.branch = req.activeBranch;
  }
  return query;
};

const buildHistoryQuery = (req) => {
  const query = getScopedAttendanceQuery(req);
  const {
    role,
    userId,
    status,
    from,
    to,
  } = req.query || {};

  if (role) {
    query.role = role;
  }
  if (status) {
    query.status = status;
  }
  if (userId) {
    query.user = userId;
  }

  if (from || to) {
    const range = {};
    if (from) range.$gte = String(from);
    if (to) range.$lte = String(to);
    query.day = range;
  }

  return query;
};

const summarizeAttendance = (rows) => {
  const total = rows.length;
  const present = rows.filter((row) => row.status === "present" || row.status === "late" || row.status === "on-site" || row.status === "remote").length;
  const late = rows.filter((row) => row.status === "late").length;
  const leave = rows.filter((row) => row.status === "leave").length;
  const absent = rows.filter((row) => row.status === "absent").length;
  const leaveOrAbsent = leave + absent;
  const attendanceRate = total > 0 ? Number(((present / total) * 100).toFixed(2)) : 0;

  return {
    totalCount: total,
    presentCount: present,
    lateCount: late,
    leaveCount: leave,
    absentCount: absent,
    leaveOrAbsentCount: leaveOrAbsent,
    attendanceRate,
  };
};

const getMyTodayAttendance = async (req, res) => {
  try {
    const day = dayKey();
    const attendance = await Attendance.findOne({ user: req.authUser._id, day });
    return res.json({ attendance: attendance ? toView(attendance, req.authUser) : null });
  } catch (error) {
    console.error("Failed to get today attendance:", error);
    return res.status(500).json({ message: "Failed to get attendance" });
  }
};

const upsertMyAttendance = async (req, res) => {
  try {
    const day = dayKey();
    const { status, branch = "", notes = "" } = req.body || {};

    if (!status) {
      return res.status(400).json({ message: "Status is required" });
    }

    const normalizedBranch = (req.authUser.role === "admin" || req.authUser.role === "technician")
      ? req.activeBranch
      : branch;

    const attendance = await Attendance.findOneAndUpdate(
      { user: req.authUser._id, day },
      {
        $set: {
          role: req.authUser.role,
          status,
          branch: normalizedBranch,
          notes,
        },
      },
      { new: true, upsert: true }
    );

    return res.json({ attendance: toView(attendance, req.authUser) });
  } catch (error) {
    console.error("Failed to upsert attendance:", error);
    return res.status(500).json({ message: "Failed to update attendance" });
  }
};

const getTodayAttendance = async (req, res) => {
  try {
    if (!isAdminRole(req.authUser.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const day = dayKey();
    const query = { day };
    if (req.authUser.role !== "superadmin") {
      query.branch = req.activeBranch;
    }
    const attendance = await Attendance.find(query).populate("user").sort({ updatedAt: -1 });
    return res.json({
      attendance: attendance.map((a) => toView(a, a.user)),
      summary: summarizeAttendance(attendance),
    });
  } catch (error) {
    console.error("Failed to get today attendance:", error);
    return res.status(500).json({ message: "Failed to get attendance" });
  }
};

const getAttendanceHistory = async (req, res) => {
  try {
    if (!isAdminRole(req.authUser.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const query = buildHistoryQuery(req);
    const attendance = await Attendance.find(query).populate("user").sort({ day: -1, updatedAt: -1 }).limit(limit);

    return res.json({
      attendance: attendance.map((a) => toView(a, a.user)),
      summary: summarizeAttendance(attendance),
      filters: {
        role: req.query?.role || "",
        status: req.query?.status || "",
        userId: req.query?.userId || "",
        from: req.query?.from || "",
        to: req.query?.to || "",
        limit,
      },
    });
  } catch (error) {
    console.error("Failed to get attendance history:", error);
    return res.status(500).json({ message: "Failed to get attendance history" });
  }
};

const listAttendanceUsers = async (req, res) => {
  try {
    if (!isAdminRole(req.authUser.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const query = {};
    if (req.authUser.role !== "superadmin") {
      query.$or = [
        { assignedBranch: req.activeBranch },
        { activeBranch: req.activeBranch },
        { assignedBranch: "" },
        { activeBranch: "" },
      ];
    }

    if (req.query?.role) {
      query.role = req.query.role;
    }

    const users = await User.find(query).sort({ name: 1, email: 1 }).limit(500);
    return res.json({ users: users.map((u) => u.toJSON()) });
  } catch (error) {
    console.error("Failed to list attendance users:", error);
    return res.status(500).json({ message: "Failed to list users" });
  }
};

const updateAttendanceRecord = async (req, res) => {
  try {
    if (!isAdminRole(req.authUser.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { attendanceId } = req.params;
    const { status, notes, day, role } = req.body || {};

    const attendance = await Attendance.findById(attendanceId).populate("user");
    if (!attendance) {
      return res.status(404).json({ message: "Attendance record not found" });
    }

    if (req.authUser.role !== "superadmin" && attendance.branch && attendance.branch !== req.activeBranch) {
      return res.status(403).json({ message: "Forbidden for another branch" });
    }

    if (status !== undefined) attendance.status = status;
    if (notes !== undefined) attendance.notes = notes;
    if (day !== undefined) attendance.day = String(day);
    if (role !== undefined) attendance.role = role;

    await attendance.save();
    return res.json({ attendance: toView(attendance, attendance.user) });
  } catch (error) {
    console.error("Failed to update attendance record:", error);
    return res.status(500).json({ message: "Failed to update attendance" });
  }
};

module.exports = {
  getMyTodayAttendance,
  upsertMyAttendance,
  getTodayAttendance,
  getAttendanceHistory,
  listAttendanceUsers,
  updateAttendanceRecord,
};

