const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

const PROJECT_STATUSES = new Set(["active", "paused", "completed", "cancelled"]);
const PROJECT_PRIORITIES = new Set(["low", "medium", "high"]);
const TASK_STATUSES = new Set(["todo", "doing", "done", "blocked"]);

const toNullableText = (value) => {
  const text = String(value ?? "").trim();
  return text || null;
};

const toNullableDate = (value) => {
  const text = String(value ?? "").trim();
  return text || null;
};

const toBudgetAmount = (value) => {
  if (value === "" || value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

async function verifyOptionalReference({ table, id, userId, label }) {
  if (!id) return null;

  const { data, error } = await supabase
    .from(table)
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    const err = new Error(error.message);
    err.status = 500;
    throw err;
  }

  if (!data) {
    const err = new Error(`${label} no encontrada`);
    err.status = 404;
    throw err;
  }

  return id;
}

async function assertProjectOwned(projectId, userId) {
  const { data, error } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    const err = new Error(error.message);
    err.status = 500;
    throw err;
  }

  if (!data) {
    const err = new Error("Proyecto no encontrado");
    err.status = 404;
    throw err;
  }

  return data;
}

function normalizeProjectPayload(body, { partial = false } = {}) {
  const patch = {};

  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? "").trim();
    if (!name) {
      const err = new Error("El nombre es obligatorio");
      err.status = 400;
      throw err;
    }
    patch.name = name;
  }

  if (!partial || body.description !== undefined) {
    patch.description = toNullableText(body.description);
  }

  if (!partial || body.status !== undefined) {
    const status = body.status || "active";
    if (!PROJECT_STATUSES.has(status)) {
      const err = new Error("Estado invalido");
      err.status = 400;
      throw err;
    }
    patch.status = status;
  }

  if (!partial || body.priority !== undefined) {
    const priority = body.priority || "medium";
    if (!PROJECT_PRIORITIES.has(priority)) {
      const err = new Error("Prioridad invalida");
      err.status = 400;
      throw err;
    }
    patch.priority = priority;
  }

  if (!partial || body.start_date !== undefined) {
    patch.start_date = toNullableDate(body.start_date);
  }

  if (!partial || body.due_date !== undefined) {
    patch.due_date = toNullableDate(body.due_date);
  }

  if (!partial || body.budget_amount !== undefined) {
    const budget = toBudgetAmount(body.budget_amount);
    if (budget == null) {
      const err = new Error("Presupuesto invalido");
      err.status = 400;
      throw err;
    }
    patch.budget_amount = budget;
  }

  if (!partial || body.account_id !== undefined) {
    patch.account_id = body.account_id || null;
  }

  if (!partial || body.category_id !== undefined) {
    patch.category_id = body.category_id || null;
  }

  return patch;
}

function normalizeTaskPayload(body, { partial = false } = {}) {
  const patch = {};

  if (!partial || body.title !== undefined) {
    const title = String(body.title ?? "").trim();
    if (!title) {
      const err = new Error("El titulo es obligatorio");
      err.status = 400;
      throw err;
    }
    patch.title = title;
  }

  if (!partial || body.notes !== undefined) {
    patch.notes = toNullableText(body.notes);
  }

  if (!partial || body.status !== undefined) {
    const status = body.status || "todo";
    if (!TASK_STATUSES.has(status)) {
      const err = new Error("Estado de tarea invalido");
      err.status = 400;
      throw err;
    }
    patch.status = status;
  }

  if (!partial || body.due_date !== undefined) {
    patch.due_date = toNullableDate(body.due_date);
  }

  if (!partial || body.position !== undefined) {
    const position = Number(body.position ?? 0);
    patch.position = Number.isFinite(position) ? position : 0;
  }

  return patch;
}

function normalizeMilestonePayload(body, { partial = false } = {}) {
  const patch = {};

  if (!partial || body.title !== undefined) {
    const title = String(body.title ?? "").trim();
    if (!title) {
      const err = new Error("El titulo es obligatorio");
      err.status = 400;
      throw err;
    }
    patch.title = title;
  }

  if (!partial || body.target_date !== undefined) {
    patch.target_date = toNullableDate(body.target_date);
  }

  if (!partial || body.completed_at !== undefined) {
    patch.completed_at = body.completed_at || null;
  }

  return patch;
}

async function loadProjectChildren(userId, projectIds) {
  if (!projectIds.length) {
    return { tasksByProject: {}, milestonesByProject: {} };
  }

  const [tasksResult, milestonesResult] = await Promise.all([
    supabase
      .from("project_tasks")
      .select(
        "id, project_id, user_id, title, notes, status, due_date, position, created_at, updated_at"
      )
      .eq("user_id", userId)
      .in("project_id", projectIds)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase
      .from("project_milestones")
      .select(
        "id, project_id, user_id, title, target_date, completed_at, created_at, updated_at"
      )
      .eq("user_id", userId)
      .in("project_id", projectIds)
      .order("target_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true }),
  ]);

  if (tasksResult.error) {
    const err = new Error(tasksResult.error.message);
    err.status = 500;
    throw err;
  }

  if (milestonesResult.error) {
    const err = new Error(milestonesResult.error.message);
    err.status = 500;
    throw err;
  }

  const tasksByProject = {};
  for (const task of tasksResult.data || []) {
    tasksByProject[task.project_id] ??= [];
    tasksByProject[task.project_id].push(task);
  }

  const milestonesByProject = {};
  for (const milestone of milestonesResult.data || []) {
    milestonesByProject[milestone.project_id] ??= [];
    milestonesByProject[milestone.project_id].push(milestone);
  }

  return { tasksByProject, milestonesByProject };
}

router.get("/", authenticateUser, async (req, res) => {
  const userId = req.user.id;

  try {
    const { data: projects, error } = await supabase
      .from("projects")
      .select(
        "id, user_id, name, description, status, priority, start_date, due_date, budget_amount, account_id, category_id, created_at, updated_at"
      )
      .eq("user_id", userId)
      .order("status", { ascending: true })
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("updated_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const projectIds = (projects || []).map((project) => project.id);
    const { tasksByProject, milestonesByProject } = await loadProjectChildren(
      userId,
      projectIds
    );

    const enriched = (projects || []).map((project) => ({
      ...project,
      tasks: tasksByProject[project.id] || [],
      milestones: milestonesByProject[project.id] || [],
    }));

    return res.json({ success: true, data: enriched });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

router.post("/", authenticateUser, async (req, res) => {
  const userId = req.user.id;

  try {
    const payload = normalizeProjectPayload(req.body);

    await verifyOptionalReference({
      table: "accounts",
      id: payload.account_id,
      userId,
      label: "Cuenta",
    });
    await verifyOptionalReference({
      table: "categories",
      id: payload.category_id,
      userId,
      label: "Categoria",
    });

    const { data, error } = await supabase
      .from("projects")
      .insert([{ ...payload, user_id: userId }])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    return res.status(201).json({
      success: true,
      data: { ...data, tasks: [], milestones: [] },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

router.put("/:id", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    await assertProjectOwned(id, userId);
    const payload = normalizeProjectPayload(req.body, { partial: true });

    if (payload.account_id !== undefined) {
      await verifyOptionalReference({
        table: "accounts",
        id: payload.account_id,
        userId,
        label: "Cuenta",
      });
    }

    if (payload.category_id !== undefined) {
      await verifyOptionalReference({
        table: "categories",
        id: payload.category_id,
        userId,
        label: "Categoria",
      });
    }

    if (!Object.keys(payload).length) {
      return res.status(400).json({ error: "No hay campos para actualizar" });
    }

    const { data, error } = await supabase
      .from("projects")
      .update(payload)
      .eq("id", id)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    const { tasksByProject, milestonesByProject } = await loadProjectChildren(
      userId,
      [id]
    );

    return res.json({
      success: true,
      data: {
        ...data,
        tasks: tasksByProject[id] || [],
        milestones: milestonesByProject[id] || [],
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

router.post("/:id/complete", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    await assertProjectOwned(id, userId);

    const { data, error } = await supabase
      .from("projects")
      .update({ status: "completed" })
      .eq("id", id)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    const { tasksByProject, milestonesByProject } = await loadProjectChildren(
      userId,
      [id]
    );

    return res.json({
      success: true,
      data: {
        ...data,
        tasks: tasksByProject[id] || [],
        milestones: milestonesByProject[id] || [],
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

router.delete("/:id", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  const milestonesDelete = await supabase
    .from("project_milestones")
    .delete()
    .eq("project_id", id)
    .eq("user_id", userId);

  if (milestonesDelete.error) {
    return res.status(500).json({ error: milestonesDelete.error.message });
  }

  const tasksDelete = await supabase
    .from("project_tasks")
    .delete()
    .eq("project_id", id)
    .eq("user_id", userId);

  if (tasksDelete.error) {
    return res.status(500).json({ error: tasksDelete.error.message });
  }

  const { error } = await supabase
    .from("projects")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);

  if (error) return res.status(500).json({ error: error.message });

  return res.json({ success: true, message: "Proyecto eliminado" });
});

router.get("/:id/tasks", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    await assertProjectOwned(id, userId);

    const { data, error } = await supabase
      .from("project_tasks")
      .select("*")
      .eq("project_id", id)
      .eq("user_id", userId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

router.post("/:id/tasks", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    await assertProjectOwned(id, userId);
    const payload = normalizeTaskPayload(req.body);

    const { data, error } = await supabase
      .from("project_tasks")
      .insert([{ ...payload, project_id: id, user_id: userId }])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

router.put("/:id/tasks/:taskId", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { id, taskId } = req.params;

  try {
    await assertProjectOwned(id, userId);
    const payload = normalizeTaskPayload(req.body, { partial: true });

    if (!Object.keys(payload).length) {
      return res.status(400).json({ error: "No hay campos para actualizar" });
    }

    const { data, error } = await supabase
      .from("project_tasks")
      .update(payload)
      .eq("id", taskId)
      .eq("project_id", id)
      .eq("user_id", userId)
      .select()
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Tarea no encontrada" });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

router.delete("/:id/tasks/:taskId", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { id, taskId } = req.params;

  try {
    await assertProjectOwned(id, userId);

    const { error } = await supabase
      .from("project_tasks")
      .delete()
      .eq("id", taskId)
      .eq("project_id", id)
      .eq("user_id", userId);

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, message: "Tarea eliminada" });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

router.get("/:id/milestones", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    await assertProjectOwned(id, userId);

    const { data, error } = await supabase
      .from("project_milestones")
      .select("*")
      .eq("project_id", id)
      .eq("user_id", userId)
      .order("target_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

router.post("/:id/milestones", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    await assertProjectOwned(id, userId);
    const payload = normalizeMilestonePayload(req.body);

    const { data, error } = await supabase
      .from("project_milestones")
      .insert([{ ...payload, project_id: id, user_id: userId }])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

router.put("/:id/milestones/:milestoneId", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { id, milestoneId } = req.params;

  try {
    await assertProjectOwned(id, userId);
    const payload = normalizeMilestonePayload(req.body, { partial: true });

    if (!Object.keys(payload).length) {
      return res.status(400).json({ error: "No hay campos para actualizar" });
    }

    const { data, error } = await supabase
      .from("project_milestones")
      .update(payload)
      .eq("id", milestoneId)
      .eq("project_id", id)
      .eq("user_id", userId)
      .select()
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Hito no encontrado" });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

router.delete("/:id/milestones/:milestoneId", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { id, milestoneId } = req.params;

  try {
    await assertProjectOwned(id, userId);

    const { error } = await supabase
      .from("project_milestones")
      .delete()
      .eq("id", milestoneId)
      .eq("project_id", id)
      .eq("user_id", userId);

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, message: "Hito eliminado" });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

module.exports = router;
