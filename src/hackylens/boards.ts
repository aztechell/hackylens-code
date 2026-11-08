// SPDX-License-Identifier: MIT

const boards = [
    { id: 'huskylens-sen0305', name: 'HUSKYLENS SEN0305', width: 320, height: 240 },
    { id: 'sipeed-maix-cube', name: 'Sipeed Maix Cube', width: 240, height: 240 },
] as const;

export function boardProfile(id: string | undefined) {
    return boards.find((board) => board.id === id);
}
