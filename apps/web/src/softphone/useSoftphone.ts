// SPDX-License-Identifier: AGPL-3.0-or-later
// React view of the softphone engine (05 §5.1).
import { useSyncExternalStore } from 'react';
import { softphone } from './SoftphoneEngine.ts';

export const useSoftphone = () => useSyncExternalStore(softphone.subscribe, () => softphone.state);
