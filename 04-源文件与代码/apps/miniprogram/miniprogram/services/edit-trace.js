export function mergeEvents(current, incoming) {
    const byId = new Map(current.map((event) => [event.eventId, event]));
    for (const event of incoming) {
        byId.set(event.eventId, event);
    }
    return [...byId.values()].sort((left, right) => {
        const sequenceDifference = left.sequence - right.sequence;
        if (sequenceDifference !== 0) {
            return sequenceDifference;
        }
        if (left.eventId < right.eventId) {
            return -1;
        }
        return left.eventId > right.eventId ? 1 : 0;
    });
}
