export interface EventProcessingCheckpoint {
  version: '1';
  last_processed_seq: number;
  processed_event_ids: string[];
  updated_at: string;
}
