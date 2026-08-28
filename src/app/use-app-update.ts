import { useRegisterSW } from "virtual:pwa-register/react";

export type AppUpdate = {
  needRefresh: boolean;
  reload: () => void;
  dismiss: () => void;
};

export function useAppUpdate(): AppUpdate {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  return {
    needRefresh,
    reload: () => {
      void updateServiceWorker(true);
    },
    dismiss: () => setNeedRefresh(false),
  };
}
