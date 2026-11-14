export interface InlineButton {
  text: string
  callback_data?: string
  url?: string
}

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][]
}

export interface TgFileRef {
  file_id: string
  file_unique_id: string
  file_size?: number
  mime_type?: string
  duration?: number
  file_name?: string
}

export interface TgPhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export interface TgMessage {
  message_id: number
  chat: { id: number; type: string }
  from?: { id: number; language_code?: string; is_bot?: boolean }
  text?: string
  caption?: string
  reply_to_message?: TgMessage
  voice?: TgFileRef
  audio?: TgFileRef
  video?: TgFileRef
  document?: TgFileRef
  photo?: TgPhotoSize[]
}

export interface TgCallbackQuery {
  id: string
  from?: { id: number; language_code?: string; is_bot?: boolean }
  message?: TgMessage
  data?: string
}
