/**
 * Canonical Supabase types for the TunaEye shared project.
 * Mirrors tunaeye-kiosk `src/supabase.ts` and
 * `supabase/migrations/202610070001_shared_grading_contract.sql`.
 * Source of truth: tunaeye-kiosk `docs/SHARED_SUPABASE_CONTRACT.md`.
 * Do not add mobile-only tables or columns here.
 */
export type AppRole = 'grader' | 'admin'
export type ClientSource = 'kiosk' | 'mobile'
export type SampleType = 'sashibo_core' | 'tail_cut'
export type TunaGrade = 'A' | 'B' | 'C' | 'Invalid'
/** Grades the Raspberry Pi model / an expert can assign (kiosk typing: no 'Invalid'). */
export type AssignableGrade = 'A' | 'B' | 'C'

export type GradingRecordRow = {
  id: string
  user_id: string
  source: ClientSource
  station_id: string | null
  session_id: string
  grader_name: string
  sample_type: SampleType
  fish_id: string
  weight_kg: number | null
  grade: TunaGrade
  confidence: number | null
  result_status: string
  original_grade: AssignableGrade | null
  override_grade: AssignableGrade | null
  override_reason: string | null
  image_path: string | null
  gradcam_path: string | null
  captured_at: string
  created_at: string
  updated_at: string
}

export type GradingRecordInsert = {
  id: string
  user_id: string
  source: ClientSource
  station_id?: string | null
  session_id: string
  grader_name: string
  sample_type: SampleType
  fish_id: string
  weight_kg?: number | null
  grade: TunaGrade
  confidence?: number | null
  result_status: string
  original_grade?: AssignableGrade | null
  override_grade?: AssignableGrade | null
  override_reason?: string | null
  image_path?: string | null
  gradcam_path?: string | null
  captured_at: string
  updated_at?: string
}

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: { user_id: string; role: AppRole; display_name: string | null; created_at: string; updated_at: string }
        Insert: { user_id: string; role?: AppRole; display_name?: string | null }
        Update: { role?: AppRole; display_name?: string | null; updated_at?: string }
        Relationships: []
      }
      grading_records: {
        Row: GradingRecordRow
        Insert: GradingRecordInsert
        Update: Partial<GradingRecordInsert>
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: { client_source: ClientSource; tuna_grade: TunaGrade; sample_type: SampleType; app_role: AppRole }
    CompositeTypes: Record<string, never>
  }
}

/** Private Storage bucket from the shared contract. */
export const GRADING_IMAGES_BUCKET = 'grading-images'
