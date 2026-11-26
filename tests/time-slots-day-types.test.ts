import { describe, expect, it } from 'vitest';
import { signupAndLogin, uniqueSlug } from './helpers';

// Bell by day type: a slot belongs to a dayType ("usual", "friday", ...) and runs on some weekdays.

async function setupSchool(tag: string) {
  const { agent, switchOrganization } = await signupAndLogin(tag);
  const slug = uniqueSlug(tag);
  const org = await agent.post('/api/organizations').send({ name: `${tag} School`, slug });
  expect(org.status).toBe(201);
  await switchOrganization(slug);
  return agent;
}

describe('time slots by day type', () => {
  it('a slot with no dayType or days gets the defaults', async () => {
    const agent = await setupSchool('slot-defaults');
    const res = await agent.post('/api/time-slots').send({ name: 'Period 1', sequence: 1, startsAt: '09:00', endsAt: '09:40' });
    expect(res.status).toBe(201);
    expect(res.body.data.dayType).toBe('usual');
    expect(res.body.data.days).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('two day types may reuse sequence 1', async () => {
    const agent = await setupSchool('slot-seq');
    const usual = await agent
      .post('/api/time-slots')
      .send({ name: 'Period 1', dayType: 'usual', days: [1, 2, 3, 4], sequence: 1, startsAt: '09:00', endsAt: '09:40' });
    expect(usual.status).toBe(201);
    const friday = await agent
      .post('/api/time-slots')
      .send({ name: 'Period 1', dayType: 'friday', days: [5], sequence: 1, startsAt: '09:00', endsAt: '09:30' });
    expect(friday.status).toBe(201);

    // but the same sequence twice inside one day type is still refused
    const again = await agent
      .post('/api/time-slots')
      .send({ name: 'Another', dayType: 'friday', days: [6], sequence: 1, startsAt: '11:00', endsAt: '11:30' });
    expect(again.status).toBe(409);
    expect(again.body.message).toBe('A time slot with that sequence number already exists');

    const list = await agent.get('/api/time-slots');
    expect(list.status).toBe(200);
    expect(list.body.data.map((s: { dayType: string }) => s.dayType).sort()).toEqual(['friday', 'usual']);
    expect(list.body.data[0].days).toBeInstanceOf(Array);
  });

  it('a Friday-only bell may overlap in time with the Mon-Thu bell', async () => {
    const agent = await setupSchool('slot-fri');
    const monThu = await agent
      .post('/api/time-slots')
      .send({ name: 'Period 1', dayType: 'usual', days: [1, 2, 3, 4], sequence: 1, startsAt: '09:00', endsAt: '09:40' });
    expect(monThu.status).toBe(201);
    const friday = await agent
      .post('/api/time-slots')
      .send({ name: 'Friday 1', dayType: 'friday', days: [5], sequence: 1, startsAt: '09:10', endsAt: '09:50' });
    expect(friday.status).toBe(201);
    expect(friday.body.data.days).toEqual([5]);

    // moving the Friday bell onto Thursday as well makes them share a day, so now they clash
    const widened = await agent.patch(`/api/time-slots/${friday.body.data.id}`).send({ days: [4, 5] });
    expect(widened.status).toBe(409);
    expect(widened.body.message).toContain('overlap');
  });

  it('two slots sharing a day still cannot overlap', async () => {
    const agent = await setupSchool('slot-clash');
    const first = await agent
      .post('/api/time-slots')
      .send({ name: 'Period 1', dayType: 'usual', days: [1, 2, 3], sequence: 1, startsAt: '09:00', endsAt: '09:40' });
    expect(first.status).toBe(201);

    // shares Wednesday, different day type and sequence
    const clash = await agent
      .post('/api/time-slots')
      .send({ name: 'Mid week', dayType: 'midweek', days: [3, 4], sequence: 1, startsAt: '09:30', endsAt: '10:10' });
    expect(clash.status).toBe(409);
    expect(clash.body.message).toContain('overlap');

    // a slot that only touches is fine
    const touching = await agent
      .post('/api/time-slots')
      .send({ name: 'Period 2', dayType: 'usual', days: [1, 2, 3], sequence: 2, startsAt: '09:40', endsAt: '10:20' });
    expect(touching.status).toBe(201);

    // editing a slot's times is checked against the days it keeps
    const moved = await agent.patch(`/api/time-slots/${touching.body.data.id}`).send({ startsAt: '09:30' });
    expect(moved.status).toBe(409);
  });

  it('an empty days list is rejected', async () => {
    const agent = await setupSchool('slot-empty');
    const created = await agent
      .post('/api/time-slots')
      .send({ name: 'Period 1', days: [], sequence: 1, startsAt: '09:00', endsAt: '09:40' });
    expect(created.status).toBe(400);

    const ok = await agent.post('/api/time-slots').send({ name: 'Period 1', sequence: 1, startsAt: '09:00', endsAt: '09:40' });
    expect(ok.status).toBe(201);
    const patched = await agent.patch(`/api/time-slots/${ok.body.data.id}`).send({ days: [] });
    expect(patched.status).toBe(400);

    // other bad lists
    for (const days of [[0], [8], [1, 1], [1.5]]) {
      const bad = await agent
        .post('/api/time-slots')
        .send({ name: 'Bad', days, sequence: 2, startsAt: '11:00', endsAt: '11:40' });
      expect(bad.status).toBe(400);
    }
  });
});
