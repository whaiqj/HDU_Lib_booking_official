/** A booking confirmed by the account's own booking list and its detail page. */
export interface VerifiedBooking {
  bookingId: string;
  seatId: string;
  seatTitle: string;
  roomId: string;
  beginTime: number;
  duration: number;
}

export interface BookingMatchQuery {
  roomId: string;
  beginTime: number;
  duration: number;
  seats: Array<{ seatId: string; title: string }>;
}
