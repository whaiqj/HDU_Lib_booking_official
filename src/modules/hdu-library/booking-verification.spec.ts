import { of } from 'rxjs';
import { HduLibraryClientService } from './hdu-library-client.service';

describe('myBookingList + bookingInfo exact verification', () => {
  const query = {
    roomId: '1559', beginTime: 1792108800, duration: 50400,
    seats: [{ seatId: '63105', title: '209' }, { seatId: '63104', title: '208' }],
  };
  const card = { id: 22877846, seatNum: '208', time: '1792108800', duration: '50400', status: '0' };
  const detail = {
    data: { booking: {
      id: '22877846', begin_time: '1792108800', duration: '50400', status: '0',
      seat: { id: '63104', title: '208' }, space: { id: '1559' },
    } },
  };
  const makeClient = (items: object[], booking = detail) => {
    const get = jest.fn().mockReturnValueOnce(of({ data: { content: { defaultItems: items } } }))
      .mockReturnValueOnce(of({ data: booking }));
    const client = new HduLibraryClientService({ get } as any, {
      getCredentials: () => ({ value: 'sid=test' }),
    } as any);
    return { client, get };
  };

  it('matches the account booking only after detail confirms room, seat ID and time', async () => {
    const { client, get } = makeClient([card]);
    await expect(client.findMatchingBooking('account', query)).resolves.toMatchObject({
      bookingId: '22877846', seatId: '63104', seatTitle: '208', roomId: '1559',
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][0]).toContain('/Seat/Index/myBookingList?LAB_JSON=1');
    expect(get.mock.calls[1][0]).toContain('/Seat/Index/bookingInfo?bookingId=22877846&LAB_JSON=1');
  });

  it.each([
    [{ ...card, time: '1792022400' }, detail],
    [card, { data: { booking: { ...detail.data.booking, space: { id: '1558' } } } }],
    [card, { data: { booking: { ...detail.data.booking, seat: { id: '63103', title: '207' } } } }],
    [card, { data: { booking: { ...detail.data.booking, status: '4' } } }],
  ])('rejects a different date, room, seat or cancelled booking', async (item, booking) => {
    const { client } = makeClient([item], booking);
    await expect(client.findMatchingBooking('account', query)).resolves.toBeNull();
  });

  it('does not treat a non-booking response as an empty authoritative list', async () => {
    const get = jest.fn().mockReturnValue(of({ data: { is_login: false } }));
    const client = new HduLibraryClientService({ get } as any, {
      getCredentials: () => ({ value: 'sid=test' }),
    } as any);
    await expect(client.findMatchingBooking('account', query)).rejects.toThrow();
  });
});
