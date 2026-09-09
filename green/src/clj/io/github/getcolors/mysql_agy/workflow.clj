(ns io.github.getcolors.mysql-agy.workflow
  "Application lifecycle around the shared compute library."
  (:require [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.workflow :as wf]
                        [io.github.getcolors.mysql-agy.ssh :as ssh]
            [io.github.getcolors.mysql-agy.ssh-config :as ssh-config]
            [io.github.getcolors.mysql-agy.tools :as tools]
            [io.github.getcolors.mysql-agy.validate :as validate]))

(def defaults
  {:compute-prevent-destroy true
   :provider-compute validate/default-compute-provider
   :provider-dns "cloudflare"
   :provider-backend "r2"
   :workdir ".colors"})

(def credential-events
  "Events that reach a provider and therefore need credentials. `build` is
  deliberately absent: a fresh checkout with an empty environment must render."
  #{:create :delete :health})

(defn- real-credential-event? [{:keys [event real?]}]
  (boolean (and real? (credential-events event))))

(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env] (start-step opts env nil))
  ([opts env _]
   (lifecycle/preflight opts
     {:defaults defaults :overlay green-cli/read-pars
      :validators [(fn [_ env _] (validate/env-errors env))
                   (fn [opts _ _] (validate/state-errors opts))
                   (fn [opts _ ctx]
                     (when (and (real-credential-event? ctx) (empty? (validate/state-errors opts))) (validate/secret-errors opts)))
                   (fn [opts _ {:keys [event real?]}]
                     (when (and real? (= :delete event) (:compute-prevent-destroy opts))
                       ["compute destruction is protected; set COLORS_PAR_COMPUTE_PREVENT_DESTROY=false for this one delete"]))]
      :after-validate (fn [opts _ {:keys [event real?]}]
                        (if (and real? (= :create event)) (ssh-config/preflight! opts)
                            (assoc (ssh/with-machine-key opts) :green/exit 0)))} env)))

(defn wire-fn [step run-opts]
  (case (:green/event run-opts)
    :delete
    ;; The `~/.ssh/config` block goes before the destroy, the keypair after it.
    ;; A block that outlives its host is stale but harmless; a key that
    ;; predeceases its host locks the operator out of members that still
    ;; exist. Both orders are deliberate — standards/ssh-config.md §4 is
    ;; explicit that they must not be tidied into agreement.
    (case step
      :mysql-agy/start [start-step :mysql-agy/load-infrastructure]
      :mysql-agy/load-infrastructure [tools/load-infrastructure-step :mysql-agy/cleanup]
      :mysql-agy/cleanup [tools/cleanup-step :mysql-agy/ansible-local]
      :mysql-agy/ansible-local [tools/ansible-local-step :mysql-agy/dns]
      :mysql-agy/dns [tools/dns-step :mysql-agy/infrastructure]
      :mysql-agy/infrastructure [tools/infrastructure-step])

    :health
    (case step
      :mysql-agy/start [start-step :mysql-agy/load-infrastructure]
      :mysql-agy/load-infrastructure [tools/load-infrastructure-step :mysql-agy/health]
      :mysql-agy/health [tools/health-step])

    ;; The block is written after compute, where the addresses first exist,
    ;; and before the members are converged (ssh-config.md §4).
    (case step
      :mysql-agy/start [start-step :mysql-agy/infrastructure]
      :mysql-agy/infrastructure [tools/infrastructure-step :mysql-agy/ansible-local]
      :mysql-agy/ansible-local [tools/ansible-local-step :mysql-agy/dns :mysql-agy/base]
      :mysql-agy/dns [tools/dns-step :mysql-agy/cluster]
      :mysql-agy/base [tools/base-step :mysql-agy/cluster]
      :mysql-agy/cluster [tools/cluster-step :mysql-agy/backup]
      :mysql-agy/backup [tools/backup-step :mysql-agy/health]
      :mysql-agy/health [tools/health-step])))

(defn backend-advice
  "The state backend of one OpenTofu stage: `tools/backend-advice`, which the
  state reader also runs, so a delete from a fresh clone finds its state."
  [tool]
  (tools/backend-advice tool))

(def side-effecting
  [:mysql-agy/infrastructure :mysql-agy/load-infrastructure :mysql-agy/ansible-local
   :mysql-agy/dns :mysql-agy/base :mysql-agy/cluster :mysql-agy/backup
   :mysql-agy/health :mysql-agy/cleanup])

(def workflow
  (-> (wf/workflow {:start :mysql-agy/start :wire-fn wire-fn
                    :next-fn (fn [_ successors opts]
                               (if (or (:mysql-agy/already-destroyed opts) (wf/failed? opts)) []
                                   (mapv #(vector % opts) successors)))})
      progress/advise
      (dry-run/advise side-effecting)
      (wf/advice-add :mysql-agy/dns :before ::backend-dns (backend-advice tools/dns-tool))))
