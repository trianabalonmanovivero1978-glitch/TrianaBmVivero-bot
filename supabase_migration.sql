-- ============================================================
-- MIGRACIÓN: Tabla training_sessions para Triana Digital Core
-- Ejecutar en Supabase → SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS training_sessions (
  id                   BIGSERIAL PRIMARY KEY,
  entrenador_id        UUID REFERENCES socios(id) ON DELETE SET NULL,
  telegram_chat_id     TEXT NOT NULL,
  telegram_user_id     TEXT NOT NULL,
  descripcion_original TEXT NOT NULL,
  contents             TEXT NOT NULL,
  objectives           JSONB NOT NULL DEFAULT '[]',
  fecha                DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para las consultas del dashboard del DT
CREATE INDEX idx_training_sessions_fecha       ON training_sessions (fecha DESC);
CREATE INDEX idx_training_sessions_entrenador  ON training_sessions (entrenador_id);
CREATE INDEX idx_training_sessions_objectives  ON training_sessions USING GIN (objectives);

-- RLS: habilitado
ALTER TABLE training_sessions ENABLE ROW LEVEL SECURITY;

-- Política: el DT y la directiva pueden ver todo
CREATE POLICY "dt_ve_todo" ON training_sessions
  FOR SELECT
  USING (
    auth.jwt() ->> 'role' IN ('dt', 'directiva', 'admin')
  );

-- Política: cada entrenador solo ve sus propias sesiones
CREATE POLICY "entrenador_ve_las_suyas" ON training_sessions
  FOR SELECT
  USING (
    entrenador_id = auth.uid()
  );

-- Política: la Service Role (bot) puede insertar sin restricciones
-- (la Service Role bypassa RLS por defecto en Supabase, no necesita policy explícita)
