(ns io.github.getcolors.mysql-agy.workflow
  "Lifecycle graph, preflight, and backend advice for mysql-agy."
  (:require [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.mysql-agy.tools :as tools]
            [io.github.getcolors.mysql-agy.validate :as validate]))

(def defaults
  {:compute-prevent-destroy true
   :provider-compute "digitalocean"
   :provider-dns "cloudflare"
   :provider-backend "local"
   :workdir ".colors"})

(def credential-events
  "Events that reach a provider and therefore need credentials."
  #{:create :delete :health})

(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env]
   (lifecycle/preflight
    opts
    {:defaults defaults
     :overlay green-cli/read-pars
     :validators
     [(fn [_ env _] (validate/env-errors env))
      (fn [opts _ _] (validate/state-errors opts))
      (fn [opts _ {:keys [event real?]}]
        (when (and real? (credential-events event)) (validate/secret-errors opts)))
      (fn [opts _ {:keys [event real?]}]
        (when (and real? (= :delete event) (:compute-prevent-destroy opts))
          [(str "compute destruction is protected; set "
                (green-cli/par-name :compute-prevent-destroy) "=false to delete")]))]}
    env)))

(defn wire-fn [step run-opts]
  (case (:green/event run-opts)
    :delete
    (case step
      :mysql-agy/start [start-step :mysql-agy/load-infrastructure]
      :mysql-agy/load-infrastructure [tools/load-infrastructure-step :mysql-agy/cleanup]
      :mysql-agy/cleanup [tools/cleanup-step :mysql-agy/dns]
      :mysql-agy/dns [tools/dns-step :mysql-agy/infrastructure]
      :mysql-agy/infrastructure [tools/infrastructure-step])

    :health
    (case step
      :mysql-agy/start [start-step :mysql-agy/load-infrastructure]
      :mysql-agy/load-infrastructure [tools/load-infrastructure-step :mysql-agy/health]
      :mysql-agy/health [tools/health-step])

    (case step
      :mysql-agy/start [start-step :mysql-agy/infrastructure]
      :mysql-agy/infrastructure [tools/infrastructure-step :mysql-agy/dns :mysql-agy/base]
      :mysql-agy/dns [tools/dns-step :mysql-agy/cluster]
      :mysql-agy/base [tools/base-step :mysql-agy/cluster]
      :mysql-agy/cluster [tools/cluster-step :mysql-agy/backup]
      :mysql-agy/backup [tools/backup-step :mysql-agy/health]
      :mysql-agy/health [tools/health-step])))

(defn backend-advice [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tools/tool-dir % tool)
    :key-fn #(str (:profile %) "/" tool ".tfstate")}))

(def side-effecting
  [:mysql-agy/infrastructure :mysql-agy/load-infrastructure :mysql-agy/dns
   :mysql-agy/base :mysql-agy/cluster :mysql-agy/backup :mysql-agy/health
   :mysql-agy/cleanup])

(def workflow
  (-> (reduce (fn [w tool]
                (wf/advice-add w (keyword "mysql-agy" (subs tool (count "mysql-agy-")))
                               :before (keyword "io.github.getcolors.mysql-agy.workflow"
                                                (str "backend-" tool))
                               (backend-advice tool)))
              (-> (wf/workflow {:start :mysql-agy/start :wire-fn wire-fn})
                  progress/advise
                  (dry-run/advise side-effecting))
              tools/tofu-tools)
      (wf/advice-add :mysql-agy/load-infrastructure
                     :before ::backend-load-infrastructure
                     (backend-advice tools/infrastructure-tool))))
